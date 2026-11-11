"""Usage web page for the Razonamiento plugin.

Indexes the transcripts with uso.py, fills uso_web.html with the data, writes ~/.claude/uso/uso.html
and opens it in the browser. The page filters by period and project by itself, with no server.
The /uso command passes the rate limits, which only the engine knows, as --limits JSON.

  python uso_web.py [--limits JSON] [--no-open]
"""
import argparse, json, os, sqlite3, sys, time, webbrowser
from datetime import datetime

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import uso  # noqa: E402

PAGE = os.path.join(uso.DIR, 'uso.html')
LOG = os.path.join(uso.DIR, 'limites.json')
FAMILIES = ['opus', 'fable', 'sonnet', 'haiku']
HOUR = 3600 * 1000
WEEK = 7 * 24 * HOUR


def reset_ms(iso):
    try:
        return int(datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp() * 1000)
    except (AttributeError, ValueError):
        return None


def model_name(m):
    m = (m or 'otro').replace('claude-', '')
    parts = m.split('-')
    # Drop a trailing date stamp such as 20251001.
    return '-'.join(p for p in parts if not (p.isdigit() and len(p) == 8))


def family(model):
    return next((i for i, f in enumerate(FAMILIES) if f in (model or '')), 0)


def solve(a, b):
    # Gaussian elimination for the small normal equations of the fit; standard library only.
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda i: abs(m[i][c]))
        m[c], m[p] = m[p], m[c]
        if abs(m[c][c]) < 1e-12:
            return None
        for i in range(n):
            if i != c:
                f = m[i][c] / m[c][c]
                m[i] = [x - f * y for x, y in zip(m[i], m[c])]
    return [m[i][n] / m[i][i] for i in range(n)]


def plan_value(db, log):
    """What a full weekly limit is worth at API prices, per model family.

    Each reading of the weekly limit says: the percentage used since the window opened (resetsAt minus 7 days)
    equals the sum, per family, of what was spent since then times what each dollar of that family costs in %.
    The fit pulls every family toward the pooled figure (all models priced alike against the limit), and only
    lets a family move away from it where the readings carry enough of that family's spending to tell.
    """
    eqs = []
    for t, kind, pct, reset in log:
        end = reset_ms(reset)
        if kind != 'seven_day' or not end or pct < 1 or t > end:
            continue
        c = [0.0] * 4
        for m, v in db.execute('select model, sum(cost) from msgs where ts>=? and ts<=? group by model', (end - WEEK, t)):
            c[family(m)] += v or 0
        if sum(c) > 1:
            eqs.append((c, pct, end))
    if not eqs:
        return None
    pooled = sum(p * sum(c) for c, p, _ in eqs) / sum(sum(c) ** 2 for c, _, _ in eqs)
    ctc = [[sum(c[i] * c[j] for c, _, _ in eqs) for j in range(4)] for i in range(4)]
    ctp = [sum(c[i] * p for c, p, _ in eqs) for i in range(4)]
    # The pull: as strong as a tenth of the average equation, so a family needs a real share of the spending to move.
    lam = 0.1 * sum(ctc[i][i] for i in range(4)) / len(eqs)
    w = solve([[ctc[i][j] + (lam if i == j else 0) for j in range(4)] for i in range(4)],
              [ctp[i] + lam * pooled for i in range(4)]) or [pooled] * 4
    spent = [sum(c[i] for c, _, _ in eqs) for i in range(4)]
    total = sum(spent) or 1
    windows = len({e for _, _, e in eqs})
    out = []
    for i in range(4):
        share = spent[i] / total
        measured = len(eqs) >= 20 and share >= 0.1 and w[i] > 0
        wi = w[i] if measured else pooled
        out.append({'week': round(100 / wi, 2), 'measured': measured, 'share': round(share, 3)})
    return {'families': out, 'pooled': round(100 / pooled, 2), 'readings': len(eqs), 'windows': windows,
            'first': min(t for t, k, *_ in log if k == 'seven_day')}


def load_log(limits, now, path=LOG):
    try:
        with open(path, encoding='utf-8') as f:
            log = json.load(f)
    except (OSError, ValueError):
        log = []
    # The readings this call brought count too, written back so the history grows even without the panel.
    changed = False
    for l in limits:
        prev = next((x for x in reversed(log) if x[1] == l.get('kind')), None)
        row = [now, l.get('kind'), l.get('pct'), l.get('resetsAt') or '']
        if l.get('pct') is not None and (not prev or prev[2:] != row[2:]):
            log.append(row)
            changed = True
    if changed:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(log[-50000:], f)
    return log


def data(db, limits, now, log_path=LOG):
    q = lambda sql, *a: db.execute(sql, a).fetchall()
    titles = {s: (uso.project(cwd), t) for s, cwd, t in q('select sess, cwd, title from sessions')}

    sessions, s_index = [], {}
    days, d_index = [], {}
    models, m_index = [], {}

    def idx(table, index, value):
        if value not in index:
            index[value] = len(table)
            table.append(value)
        return index[value]

    def sess(s):
        if s not in s_index:
            project, title = titles.get(s, ('Sin carpeta', None))
            s_index[s] = len(sessions)
            sessions.append([(title or 'Sin titulo').replace('\n', ' ')[:140], project])
        return s_index[s]

    local = "date(ts/1000,'unixepoch','localtime')"
    dates = sorted(r[0] for r in q(f'select distinct {local} from msgs'))
    for d in dates:
        idx(days, d_index, d)

    rows = {}
    for d, s, m, c, sub, cr, inp, out, think, n in q(f"""
            select {local}, sess, model, sum(cost), sum(case when sub=1 then cost else 0 end), sum(cr),
                   sum(inp+cw5+cw1+cr), sum(out), sum(think), count(*) from msgs group by 1, 2, 3"""):
        k = (d_index[d], sess(s), idx(models, m_index, model_name(m)))
        cur = rows.setdefault(k, [0, 0, 0, 0, 0, 0, 0])
        for i, v in enumerate((c, sub, cr, inp, out, think, n)):
            cur[i] += v or 0
    rows = [[*k, round(v[0], 4), round(v[1], 4), *v[2:]] for k, v in rows.items()]

    heat = {}
    for d, h, s, m, c in q(f"""
            select {local}, strftime('%H', ts/1000, 'unixepoch', 'localtime'), sess, model, sum(cost)
            from msgs where ts>=? group by 1, 2, 3, 4""", now - 120 * 24 * HOUR):
        k = (d_index[d], int(h), sess(s), family(m))
        heat[k] = heat.get(k, 0) + (c or 0)
    heat = [[*k, round(c, 4)] for k, c in heat.items() if c]

    prompts = [{'text': (t or '').strip()[:600], 'ts': ts, 's': sess(s), 'cost': round(c, 2)} for t, ts, s, c in q("""
            select p.text, p.ts, p.sess, sum(m.cost) c from msgs m join prompts p on p.id=m.turn
            where m.ts>=? group by m.turn order by c desc limit 300""", now - 120 * 24 * HOUR)]

    w = {}
    for kind, span, name in (('five_hour', 5 * HOUR, 'w5'), ('seven_day', WEEK, 'w7')):
        end = reset_ms(next((l.get('resetsAt') for l in limits if l.get('kind') == kind), None))
        if end:
            w[name] = q('select coalesce(sum(cost),0) from msgs where ts>=?', end - span)[0][0]

    # Day by day detail is complete from the day after the last gap of a week or more; before it only month totals are sure.
    full = dates[0] if dates else None
    for a, b in zip(dates, dates[1:]):
        if (datetime.fromisoformat(b) - datetime.fromisoformat(a)).days >= 7:
            full = b

    rep = uso.report(db, None, None)
    week0 = now - 7 * 24 * HOUR
    c7 = q('select sum(cr), sum(inp+cw5+cw1+cr), sum(cost), sum(case when inp+cw5+cw1+cr>200000 then cost else 0 end),'
           ' sum(case when sub=1 then cost else 0 end) from msgs where ts>=?', week0)[0]
    log = load_log(limits, now, log_path)
    history = [[t, p, r] for t, k, p, r in log if k == 'seven_day' and t >= now - 60 * 24 * HOUR]
    return {
        'plan': plan_value(db, log), 'history': history,
        'generated': now, 'full': full, 'limits': limits, 'w': w, 'days': days, 'models': models, 'sessions': sessions,
        'rows': rows, 'heat': heat, 'prompts': prompts, 'months': rep['months'],
        'tips': uso.tips(q, week0, c7[2] or 0, c7),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limits', default='[]')
    ap.add_argument('--no-open', action='store_true')
    ap.add_argument('--log', default=LOG, help='limit readings file; tests point it elsewhere')
    a = ap.parse_args()
    limits = json.loads(a.limits)
    now = int(time.time() * 1000)
    if not limits:
        # Opened without Claude: the last reading the panel saved for each limit, while its window is still open.
        try:
            with open(a.log, encoding='utf-8') as f:
                log = json.load(f)
        except (OSError, ValueError):
            log = []
        last = {}
        for t, kind, pct, reset in log:
            last[kind] = {'kind': kind, 'pct': pct, 'resetsAt': reset or None}
        limits = [l for l in last.values() if (reset_ms(l['resetsAt']) or 0) > now]

    os.makedirs(uso.DIR, exist_ok=True)
    db = sqlite3.connect(uso.DB, timeout=60)
    db.executescript(uso.SCHEMA)
    while uso.index(db, 120):
        pass
    payload = json.dumps(data(db, limits, now, a.log), ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    with open(os.path.join(HERE, 'uso_web.html'), encoding='utf-8') as f:
        page = f.read().replace('/*DATA*/null', payload, 1)
    with open(PAGE, 'w', encoding='utf-8') as f:
        f.write(page)
    if not a.no_open:
        webbrowser.open('file:///' + PAGE.replace(os.sep, '/').lstrip('/'))
    print(PAGE)


if __name__ == '__main__':
    main()
