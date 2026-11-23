"""Compares a Code Mode arm file with the baseline. Run from the repository root:

    python docs/research/data/compare-arms.py docs/research/data/1.9.5-code-arm-3.jsonl
"""
import json, math, statistics, collections, sys

def load(p):
    return [json.loads(l) for l in open(p, encoding='utf-8-sig') if l.strip()]

base = load('docs/research/data/0.2.5-baseline.jsonl')
code = load(sys.argv[1])

def final(rows):
    # the last attempt for each (target, arm, task, run)
    out = {}
    for r in rows:
        out[(r['target'], r['arm'], r['taskId'], r['run'])] = r
    return list(out.values())

rows = final(base) + final(code)

def wilson(k, n, z=1.96):
    if n == 0: return (0, 0)
    p = k / n
    d = 1 + z*z/n
    c = (p + z*z/(2*n)) / d
    h = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / d
    return (c-h, c+h)

def newcombe(k1, n1, k2, n2):
    # difference p1 - p2 with Newcombe's interval from two Wilson intervals
    p1, p2 = k1/n1, k2/n2
    l1, u1 = wilson(k1, n1); l2, u2 = wilson(k2, n2)
    d = p1 - p2
    return d, d - math.sqrt((p1-l1)**2 + (u2-p2)**2), d + math.sqrt((u1-p1)**2 + (p2-l2)**2)

targets = sorted({r['target'] for r in rows})
types = sorted({r['taskType'] for r in rows})
for t in targets:
    print('==', t)
    for ty in types + ['ALL']:
        for arm in ['direct', 'tool_search', 'code']:
            g = [r for r in rows if r['target'] == t and r['arm'] == arm and (ty == 'ALL' or r['taskType'] == ty)]
            if not g: continue
            k = sum(r['success'] for r in g); n = len(g)
            lo, hi = wilson(k, n)
            print(f"  {ty:20s} {arm:12s} n={n:3d} correct={k:3d} ({100*k/n:5.1f}%, {100*lo:.1f}-{100*hi:.1f})  in={statistics.mean(r['inputTokens'] for r in g):9.0f} median_in={statistics.median(r['inputTokens'] for r in g):9.0f} out={statistics.mean(r['outputTokens'] for r in g):6.0f} turns={statistics.mean(r['turns'] for r in g):4.1f} calls={statistics.mean(r['toolCalls'] for r in g):4.1f} cost=${sum(r['costUsd'] for r in g):.3f} wall={statistics.median(r['wallClockMs'] for r in g)/1000:.1f}s")
        d = [r for r in rows if r['target'] == t and r['arm'] == 'direct' and (ty == 'ALL' or r['taskType'] == ty)]
        c = [r for r in rows if r['target'] == t and r['arm'] == 'code' and (ty == 'ALL' or r['taskType'] == ty)]
        if d and c:
            md = statistics.mean(r['inputTokens'] for r in d); mc = statistics.mean(r['inputTokens'] for r in c)
            diff, lo, hi = newcombe(sum(r['success'] for r in c), len(c), sum(r['success'] for r in d), len(d))
            print(f"  {ty:20s} code vs direct: input tokens {100*(mc-md)/md:+.1f}%   success {100*diff:+.1f} points (95% interval {100*lo:+.1f} to {100*hi:+.1f})")
    # tasks
    per = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        if r['target'] == t: per[r['taskId']][r['arm']].append(r)
    worse = []
    for task, arms in per.items():
        if 'code' not in arms or 'direct' not in arms: continue
        dk = sum(r['success'] for r in arms['direct']); ck = sum(r['success'] for r in arms['code'])
        md = statistics.mean(r['inputTokens'] for r in arms['direct']); mc = statistics.mean(r['inputTokens'] for r in arms['code'])
        if ck < len(arms['code']) or mc > md:
            worse.append((task, arms['code'][0]['taskType'], f"direct {dk}/{len(arms['direct'])}", f"code {ck}/{len(arms['code'])}", f"in direct {md:.0f} code {mc:.0f} ({100*(mc-md)/md:+.0f}%)"))
    print('  tasks where code failed a run or used more input tokens:', len(worse), 'of', len(per))
    for w in sorted(worse, key=lambda x: x[1]): print('   ', *w)
    # scripts
    runs = [o for r in code if r['target'] == t for o in r.get('codeRuns', [])]
    st = collections.Counter((o['status'], o.get('errorCode')) for o in runs)
    print('  scripts run:', len(runs), 'per task:', round(len(runs)/150, 2), dict(st), 'truncated:', sum(o['truncated'] for o in runs))
    closed = sum(1 for r in code if r['target'] == t and any(o['status'] == 'refused' for o in r.get('codeRuns', [])))
    print('  tasks with a run refused by the retry gate:', closed)
print('code arm cost', round(sum(r['costUsd'] for r in code), 4), 'providers', collections.Counter(r['provider'] for r in code))
print('baseline providers', collections.Counter((r['arm'], r['provider']) for r in final(base)))
