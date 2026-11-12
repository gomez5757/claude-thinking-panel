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


# How fast each model spends the plan's limit, per token weighted by type: input 1, cache write 1.25, output and
# thinking 5, cache read 0.025. Measured on a subscription in September 2026 by
# https://zenn.dev/tksfjt1024/articles/25c0ab111c277c and not published by Anthropic. Haiku 5.5 and Fable 5.2 came
# out later. Within a family the weight followed the input price (Opus 5 to 5.5: price and weight both x0.8), so they
# get their predecessor's weight times the price change.
WEIGHTS = {'claude-opus-5-5': 2.2, 'claude-opus-5': 2.75, 'claude-opus-4': 2.75, 'claude-sonnet-5': 1.5, 'claude-sonnet-4': 2.25,
           'claude-haiku-5-5': 0.1, 'claude-haiku-4': 1, 'claude-fable-5-2': 8, 'claude-fable-5': 10}
MEASURED = ('claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4')
CURRENT = ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5']
TOKENS = 'inp + 1.25 * (cw5 + cw1) + 5 * out + 0.025 * cr'


def weight(model):
    model = (model or '').split('[')[0]
    best = max((k for k in WEIGHTS if model.startswith(k)), key=len, default=None)
    return WEIGHTS[best] if best else 2.2


def units(db, a, b):
    return sum(weight(m) * (t or 0) for m, t in db.execute(
        f'select model, sum({TOKENS}) from msgs where ts>=? and ts<=? group by model', (a, b)))


def plan_value(db, log, now):
    """What a full weekly limit is worth at API prices, model by model.

    Each model's dollars per unit of limit come from your own last 30 days with it: what it cost at API prices over
    the limit units it spent. A model you barely use is priced on your Opus work, as if it had done that work.
    The size of your weekly limit in units comes from your readings of the weekly percentage, against the units spent
    since that window opened. With no readings yet the page uses the size measured on the plans.
    """
    table = uso.prices()
    month0 = now - 30 * 24 * HOUR
    fam = [{'cost': 0.0, 'units': 0.0, 'tok': [0] * 5} for _ in FAMILIES]
    for m, inp, out, cw5, cw1, cr, c, t in db.execute(f"""select model, sum(inp), sum(out), sum(cw5), sum(cw1), sum(cr),
            sum(cost), sum({TOKENS}) from msgs where ts>=? group by model""", (month0,)):
        f = fam[family(m)]
        f['cost'] += c or 0
        f['units'] += weight(m) * (t or 0)
        f['tok'] = [x + (y or 0) for x, y in zip(f['tok'], (inp, out, cw5, cw1, cr))]
    total_cost = sum(f['cost'] for f in fam)
    total_units = sum(f['units'] for f in fam)
    base = fam[0] if fam[0]['units'] else max(fam, key=lambda f: f['units'])
    out = []
    for i, f in enumerate(fam):
        own = f['units'] > 0 and f['cost'] >= 0.05 * total_cost
        inp, o, cw5, cw1, cr = (f if own else base)['tok']
        model = CURRENT[i]
        u = weight(model) * (inp + 1.25 * (cw5 + cw1) + 5 * o + 0.025 * cr)
        dpu = f['cost'] / f['units'] if own else (uso.cost(table, model, inp, o, cw5, cw1, cr, None) / u if u else 0)
        out.append({'dpu': dpu * 1e6, 'measured': model.startswith(MEASURED), 'own': own,
                    'share': round(f['cost'] / (total_cost or 1), 3)})

    # Millions of units per 1% of the weekly limit: least squares through zero over the readings of the last 30 days.
    su = sp = 0.0
    n, first = 0, None
    for t, kind, pct, reset in log:
        end = reset_ms(reset)
        if kind != 'seven_day' or not end or pct < 1 or t > end or t < month0:
            continue
        u = units(db, end - WEEK, t)
        if u > 0:
            su += u * pct
            sp += pct * pct
            n += 1
            first = first or t
    return {'families': out, 'mixDpu': total_cost / total_units * 1e6 if total_units else 0, 'units30': total_units / 1e6,
            'cap': su / sp * 100 / 1e6 if sp else None, 'readings': n, 'first': first}


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
        'plan': plan_value(db, log, now), 'history': history,
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
