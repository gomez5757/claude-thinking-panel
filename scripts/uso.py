"""Usage index for the Razonamiento panel.

Reads Claude Code's transcripts (~/.claude/projects/**/*.jsonl) incrementally, by byte offset,
into a SQLite file that keeps every response forever (the transcripts are deleted after 30 days),
and prints one JSON report for the panel. Standard library only. One shot: it never stays running.

  python uso.py [--budget SECONDS] [--w5 START_MS] [--w7 START_MS]
"""
import argparse, json, os, re, sqlite3, sys, time
from datetime import datetime

HOME = os.path.expanduser('~')
PROJECTS = os.path.join(HOME, '.claude', 'projects')
DIR = os.path.join(HOME, '.claude', 'uso')
DB = os.path.join(DIR, 'uso.db')
PRICES_FILE = os.path.join(DIR, 'precios.json')
COMPACT = 'This session is being continued from a previous conversation'
METER = os.path.join(HOME, '.claude', 'medidor-historico.json')

# USD per million tokens: input, output, cache write 5 min, cache write 1 h, cache read.
# Checked against the costUSD Claude Code itself writes in each transcript (cost-state records).
# ~/.claude/uso/precios.json overrides or adds models with the same shape.
PRICES = {
    'claude-fable-5-2': [8, 40, 10, 16, 0.2],
    'claude-fable-5-1': [10, 50, 12.5, 20, 1],
    'claude-fable-5': [10, 50, 12.5, 20, 1],
    'claude-opus-5-5': [4, 20, 5, 8, 0.2],
    'claude-opus-5': [5, 25, 6.25, 10, 0.5],
    'claude-opus-4-8': [5, 25, 6.25, 10, 0.5],
    'claude-opus-4-7': [5, 25, 6.25, 10, 0.5],
    'claude-opus-4-6': [5, 25, 6.25, 10, 0.5],
    'claude-opus-4-5': [5, 25, 6.25, 10, 0.5],
    'claude-sonnet-5-5': [2, 10, 2.5, 4, 0.1],
    'claude-sonnet-5': [2, 10, 2.5, 4, 0.2],
    'claude-sonnet-4-6': [3, 15, 3.75, 6, 0.3],
    'claude-sonnet-4-5': [3, 15, 3.75, 6, 0.3],
    'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.2, 0.01],
    'claude-haiku-4-5': [1, 5, 1.25, 2, 0.1],
}
# Haiku 5.5 costs five times more on a request whose prompt passes 100k tokens.
TIERED = {'claude-haiku-5-5': (100000, 5)}
# Fast mode doubles the price on these.
FAST = {'claude-opus-5-5': 2, 'claude-fable-5-2': 2}

SCHEMA = """
create table if not exists files(path text primary key, size int, mtime real, off int);
create table if not exists msgs(k text primary key, ts int, sess text, model text, inp int, out int, cw5 int, cw1 int,
  cr int, think int, speed text, effort text, sub int, turn int, agent text, cost real);
create index if not exists msgs_ts on msgs(ts);
create table if not exists prompts(id integer primary key, sess text, ts int, text text, unique(sess, ts));
create index if not exists prompts_sess on prompts(sess, ts);
create table if not exists tools(id text primary key, sess text, ts int, name text, target text, chars int default 0);
create index if not exists tools_ts on tools(ts);
create table if not exists sessions(sess text primary key, cwd text, title text);
create table if not exists official(sess text, model text, cost real, primary key(sess, model));
create table if not exists meta(k text primary key, v text);
"""


def prices():
    table = dict(PRICES)
    try:
        with open(PRICES_FILE, encoding='utf-8') as f:
            table.update(json.load(f))
    except (OSError, ValueError):
        pass
    return table


def rate(table, model):
    model = (model or '').split('[')[0]
    best = ''
    for key in table:
        if model.startswith(key) and len(key) > len(best):
            best = key
    return best, table.get(best)


def cost(table, model, inp, out, cw5, cw1, cr, speed):
    key, p = rate(table, model)
    if not p:
        return 0.0
    c = (inp * p[0] + out * p[1] + cw5 * p[2] + cw1 * p[3] + cr * p[4]) / 1e6
    tier = TIERED.get(key)
    if tier and inp + cw5 + cw1 + cr > tier[0]:
        c *= tier[1]
    if speed == 'fast':
        c *= FAST.get(key, 1)
    return c


def ms(stamp):
    try:
        return int(datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000)
    except (AttributeError, ValueError):
        return 0


def target(name, inp):
    inp = inp or {}
    for field in ('file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description', 'skill'):
        if isinstance(inp.get(field), str):
            return inp[field][:300]
    return ''


def result_chars(content):
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(len(b.get('text') or '') + len((b.get('source') or {}).get('data') or '') // 4
                   for b in content if isinstance(b, dict))
    return 0


def prompt_text(content):
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        if any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in content):
            return None
        text = ' '.join(b.get('text') or '' for b in content if isinstance(b, dict) and b.get('type') == 'text')
    else:
        return None
    text = text.strip()
    if not text or text[0] in '<[':
        return None
    return text[:300]


class Indexer:
    def __init__(self, db, table):
        self.db = db
        self.table = table

    def line(self, raw, path, sub):
        if b'"type":"assistant"' in raw:
            d = json.loads(raw)
            if d.get('type') == 'assistant':
                self.assistant(d, path, sub)
        elif b'"type":"user"' in raw:
            d = json.loads(raw)
            if d.get('type') == 'user':
                self.user(d, sub)
        elif b'"type":"cost-state"' in raw:
            d = json.loads(raw)
            for model, u in (d.get('modelUsage') or {}).items():
                self.db.execute('insert or replace into official values(?,?,?)',
                                (d.get('sessionId'), model, u.get('costUSD') or 0))
        elif b'"type":"custom-title"' in raw:
            d = json.loads(raw)
            if d.get('sessionId') and d.get('customTitle'):
                self.db.execute('insert into sessions(sess, title) values(?,?) on conflict(sess) do update set title=excluded.title',
                                (d['sessionId'], d['customTitle'][:120]))

    def session(self, d):
        sess = d.get('sessionId') or ''
        if d.get('cwd'):
            self.db.execute('insert into sessions(sess, cwd) values(?,?) on conflict(sess) do update set cwd=coalesce(cwd, excluded.cwd)',
                            (sess, d['cwd']))
        return sess

    def assistant(self, d, path, sub):
        m = d.get('message') or {}
        u = m.get('usage') or {}
        sess = self.session(d)
        ts = ms(d.get('timestamp'))
        for block in m.get('content') or []:
            if isinstance(block, dict) and block.get('type') == 'tool_use' and block.get('id'):
                self.db.execute('insert or ignore into tools(id, sess, ts, name, target) values(?,?,?,?,?)',
                                (block['id'], sess, ts, block.get('name') or '', target(block.get('name'), block.get('input'))))
        if not u or not m.get('model') or m.get('model') == '<synthetic>':
            return
        cc = u.get('cache_creation') or {}
        cw = u.get('cache_creation_input_tokens') or 0
        cw1 = cc.get('ephemeral_1h_input_tokens') or 0
        cw5 = cc.get('ephemeral_5m_input_tokens') or 0
        if cw5 + cw1 != cw:
            cw5 = cw - cw1
        row = [u.get('input_tokens') or 0, u.get('output_tokens') or 0, cw5, cw1, u.get('cache_read_input_tokens') or 0]
        if not any(row):
            return
        think = (u.get('output_tokens_details') or {}).get('thinking_tokens') or 0
        speed = u.get('speed') or 'standard'
        key = f"{m.get('id')}:{d.get('requestId')}" if d.get('requestId') else f"{m.get('id')}:{sess}:{ts}"
        turn = self.db.execute('select id from prompts where sess=? and ts<=? order by ts desc limit 1', (sess, ts)).fetchone()
        agent = os.path.basename(path)[:-6] if sub else None
        price = cost(self.table, m['model'], *row, speed)
        # The same response is written once per content block, and again by resumed or copied sessions: keep one,
        # the one with the most tokens.
        self.db.execute(
            '''insert into msgs values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(k) do update set
               inp=excluded.inp, out=excluded.out, cw5=excluded.cw5, cw1=excluded.cw1, cr=excluded.cr,
               think=excluded.think, cost=excluded.cost
               where excluded.inp+excluded.out+excluded.cw5+excluded.cw1+excluded.cr > inp+out+cw5+cw1+cr''',
            (key, ts, sess, m['model'], *row, think, speed, d.get('effort'), int(sub), turn[0] if turn else None,
             agent, price))
        # An advisor's tokens come as extra iterations, billed at the advisor's own model.
        for i, it in enumerate(u.get('iterations') or []):
            if it.get('type') == 'message' or not it.get('model'):
                continue
            icc = it.get('cache_creation') or {}
            irow = [it.get('input_tokens') or 0, it.get('output_tokens') or 0, icc.get('ephemeral_5m_input_tokens') or 0,
                    icc.get('ephemeral_1h_input_tokens') or 0, it.get('cache_read_input_tokens') or 0]
            self.db.execute('insert or ignore into msgs values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                            (f'{key}:it{i}', ts, sess, it['model'], *irow, 0, speed, d.get('effort'), int(sub),
                             turn[0] if turn else None, agent, cost(self.table, it['model'], *irow, speed)))

    def user(self, d, sub):
        m = d.get('message') or {}
        content = m.get('content')
        sess = self.session(d)
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get('type') == 'tool_result' and b.get('tool_use_id'):
                    self.db.execute('update tools set chars=? where id=?', (result_chars(b.get('content')), b['tool_use_id']))
        if sub or d.get('isMeta') or d.get('isSidechain') or d.get('isCompactSummary'):
            return
        text = prompt_text(content)
        if text and not text.startswith(COMPACT):
            self.db.execute('insert or ignore into prompts(sess, ts, text) values(?,?,?)', (sess, ms(d.get('timestamp')), text))


def transcripts():
    out = []
    for root, _, names in os.walk(PROJECTS):
        sub = os.sep + 'subagents' in root
        for n in names:
            if n.endswith('.jsonl'):
                out.append((sub, os.path.join(root, n)))
    out.sort()  # main transcripts first, so a subagent's responses find the prompt that started them
    return out


def index(db, budget):
    table = prices()
    stamp = json.dumps(table, sort_keys=True) + json.dumps(TIERED) + json.dumps(FAST)
    old = db.execute("select v from meta where k='prices'").fetchone()
    if old and old[0] != stamp:
        for row in db.execute('select k, model, inp, out, cw5, cw1, cr, speed from msgs').fetchall():
            db.execute('update msgs set cost=? where k=?', (cost(table, row[1], *row[2:7], row[7]), row[0]))
    db.execute("insert or replace into meta values('prices', ?)", (stamp,))
    db.commit()

    ix = Indexer(db, table)
    known = {r[0]: r[1:] for r in db.execute('select path, size, mtime, off from files')}
    start = time.time()
    pending = 0
    for sub, path in transcripts():
        try:
            st = os.stat(path)
        except OSError:
            continue
        size, mtime, off = known.get(path, (0, 0, 0))
        if st.st_size == size and st.st_mtime == mtime:
            continue
        if time.time() - start > budget:
            pending += 1
            continue
        if st.st_size < off:  # rewritten shorter: read again; the keys keep it from counting twice
            off = 0
        with open(path, 'rb') as f:
            f.seek(off)
            carry = b''
            while True:
                chunk = f.read(8 << 20)
                if not chunk:
                    break
                lines = (carry + chunk).split(b'\n')
                carry = lines.pop()
                for raw in lines:
                    off += len(raw) + 1
                    if raw:
                        try:
                            ix.line(raw, path, sub)
                        except (ValueError, TypeError, AttributeError, KeyError):
                            pass
        # A last line without its newline is still being written: read it next time.
        db.execute('insert or replace into files values(?,?,?,?)', (path, st.st_size, st.st_mtime, off))
        db.commit()
    return pending


def project(cwd):
    if not cwd:
        return 'Sin carpeta'
    if 'scratch-workspaces' in cwd:
        return 'Sin carpeta'
    cwd = re.split(r'[\\/]\.claude[\\/]worktrees[\\/]', cwd)[0]
    return os.path.basename(cwd.rstrip('\\/')) or cwd


def report(db, w5, w7):
    now = int(time.time() * 1000)
    day = 86400000
    local = datetime.now().astimezone()
    midnight = int(local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
    month0 = int(local.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
    q = lambda sql, *a: db.execute(sql, a).fetchall()
    total = lambda since, until=now: q('select coalesce(sum(cost),0), coalesce(sum(inp+out+cw5+cw1+cr),0) from msgs where ts>=? and ts<?', since, until)[0]

    def spend(since, until=now):
        c, t = total(since, until)
        return {'cost': round(c, 2), 'tokens': t}

    week0 = now - 7 * day
    out = {
        'generated': now,
        'today': spend(midnight),
        'yesterday': spend(midnight - day, midnight),
        'week': spend(week0),
        'month': spend(month0),
    }
    if w5:
        out['w5'] = spend(w5)
    if w7:
        out['w7'] = spend(w7)

    out['daily'] = [{'d': d, 'cost': round(c, 2), 'opus': round(o, 2)} for d, c, o in q(
        """select date(ts/1000,'unixepoch','localtime') d, sum(cost), sum(case when model like '%opus%' or model like '%fable%' then cost else 0 end)
           from msgs where ts>=? group by d order by d""", midnight - 29 * day)]

    # Months: the index, plus the old meter for months whose transcripts are already gone.
    # The meter is only trusted where it saw clearly more messages than we still have: its Sonnet 5.5 price was wrong.
    months = {}
    for m, mod, c, n in q("select strftime('%Y-%m', ts/1000,'unixepoch','localtime') m, model, sum(cost), count(*) from msgs group by m, model"):
        months.setdefault(m, {})[mod] = (c, n)
    try:
        with open(METER, encoding='utf-8') as f:
            for m, mods in json.load(f).items():
                for mod, v in mods.items():
                    cur = months.setdefault(m, {})
                    if (v.get('n') or 0) > cur.get(mod, (0, 0))[1] * 1.02:
                        cur[mod] = (v.get('cost') or 0, v.get('n') or 0)
    except (OSError, ValueError):
        pass
    if months:
        y, mo = map(int, min(months).split('-'))
        while f'{y}-{mo:02d}' < max(months):
            months.setdefault(f'{y}-{mo:02d}', {})
            y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
    out['months'] = [{'m': m, 'cost': round(sum(c for c, _ in v.values()), 2)} for m, v in sorted(months.items())[-12:]]

    rows = q('select model, sum(cost), sum(out), sum(think), sum(cr), sum(inp+cw5+cw1+cr) from msgs where ts>=? group by model order by 2 desc', month0)
    out['models'] = [{'model': r[0].replace('claude-', ''), 'cost': round(r[1], 2), 'out': r[2], 'think': r[3]} for r in rows if r[1] >= 0.01]
    outs = sum(r[2] for r in rows) or 1
    think = sum(r[3] for r in rows)
    # Thinking is billed as output tokens, at each model's output price.
    table = prices()
    tc = sum(r[3] * (rate(table, r[0])[1] or [0, 0])[1] / 1e6 for r in rows)
    out['think'] = {'share': round(100 * think / outs), 'cost': round(tc, 2)}

    c7 = q('select sum(cr), sum(inp+cw5+cw1+cr), sum(cost), sum(case when inp+cw5+cw1+cr>200000 then cost else 0 end), sum(case when sub=1 then cost else 0 end) from msgs where ts>=?', week0)[0]
    out['cache'] = round(100 * (c7[0] or 0) / (c7[1] or 1))
    week_cost = c7[2] or 0
    out['subShare'] = round(100 * (c7[4] or 0) / (week_cost or 1))

    names = {}
    for sess, cwd, title in q('select sess, cwd, title from sessions'):
        names[sess] = (project(cwd), title)
    by_project = {}
    for sess, c in q('select sess, sum(cost) from msgs where ts>=? group by sess', now - 30 * day):
        p = names.get(sess, ('Sin carpeta', None))[0]
        by_project[p] = by_project.get(p, 0) + c
    out['projects'] = [{'name': p, 'cost': round(c, 2)} for p, c in sorted(by_project.items(), key=lambda x: -x[1])[:8]]

    out['sessions'] = [{'title': names.get(s, (None, None))[1] or 'Sin titulo', 'project': names.get(s, ('Sin carpeta',))[0], 'cost': round(c, 2)}
                       for s, c in q('select sess, sum(cost) from msgs where ts>=? group by sess order by 2 desc limit 5', week0)]
    out['prompts'] = [{'text': t, 'ts': ts, 'cost': round(c, 2)} for t, ts, c in q(
        'select p.text, p.ts, sum(m.cost) c from msgs m join prompts p on p.id=m.turn where m.ts>=? group by m.turn order by c desc limit 5', week0)]

    out['tips'] = tips(q, week0, week_cost, c7)
    out['files'] = q('select count(*) from files')[0][0]
    out['since'] = q('select min(ts) from msgs')[0][0]
    return out


def tips(q, week0, week_cost, c7):
    found = []
    seen = set()
    for name, sess, n in q("""select target, sess, count(*) n from tools where ts>=? and name='Read' and target<>''
                              group by sess, lower(target) having n>=8 order by n desc limit 20""", week0):
        if os.path.basename(name).lower() in seen or len(seen) == 2:
            continue
        seen.add(os.path.basename(name).lower())
        found.append({'title': f'{os.path.basename(name)} leido {n} veces en una misma conversacion',
                      'detail': 'Cada lectura vuelve a meter el archivo entero en la conversacion. Pide leer solo la parte que hace falta.'})
    for cmd, n in q("""select target, count(*) n from tools where ts>=? and name in ('Bash','PowerShell') and target<>''
                       group by sess, target having n>=15 order by n desc limit 1""", week0):
        cmd = ' '.join(re.sub(r'^cd\s+("[^"]*"|\S+)\s*(&&|;)\s*', '', cmd).split())
        found.append({'title': f'Un comando repetido {n} veces: {cmd[:60]}',
                      'detail': 'Suele ser una espera haciendo sondeos. Un aviso al terminar gasta menos.'})
    big = q('select count(*), coalesce(sum(chars),0) from tools where ts>=? and chars>100000', week0)[0]
    if big[0] >= 5:
        found.append({'title': f'{big[0]} resultados de herramientas enormes esta semana',
                      'detail': f'Unos {round(big[1] / 4000)}k tokens metidos de golpe en el contexto. Limitar la salida de comandos y lecturas lo evita.'})
    if week_cost and (c7[3] or 0) / week_cost > 0.3:
        found.append({'title': f'El {round(100 * c7[3] / week_cost)}% del gasto de la semana fue con mas de 200k de contexto',
                      'detail': 'Cada respuesta paga la conversacion entera. Compactar o empezar de cero antes abarata todo lo que viene despues.'})
    rows = q("select agent, sum(cost) c from msgs where ts>=? and sub=1 and agent is not null group by agent order by c", week0)
    if len(rows) >= 5:
        median = rows[len(rows) // 2][1]
        top = rows[-1]
        if top[1] > 5 and top[1] > 6 * median:
            found.append({'title': f'Un ayudante costo {top[1]:.0f} $, {top[1] / (median or 1):.0f} veces lo normal',
                          'detail': 'Revisa que tarea se le encargo: una tarea mas acotada o en varios ayudantes sale mas barata.'})
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--budget', type=float, default=240)
    ap.add_argument('--w5', type=int)
    ap.add_argument('--w7', type=int)
    ap.add_argument('--check', action='store_true', help='compare with the costs Claude Code writes itself')
    a = ap.parse_args()
    os.makedirs(DIR, exist_ok=True)
    db = sqlite3.connect(DB, timeout=60)
    db.executescript(SCHEMA)
    pending = index(db, a.budget)
    if a.check:
        rows = db.execute('''select o.model, sum(o.cost), sum(m.c) from official o join
                             (select sess, model, sum(cost) c from msgs group by sess, model) m
                             on m.sess=o.sess and m.model=o.model group by o.model''').fetchall()
        print(json.dumps([{'model': r[0], 'official': round(r[1], 2), 'ours': round(r[2], 2)} for r in rows], indent=1))
        return
    out = report(db, a.w5, a.w7)
    out['pending'] = pending
    sys.stdout.write(json.dumps(out))


if __name__ == '__main__':
    main()
