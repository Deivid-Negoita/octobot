"""Build the bill of materials from the PCB layout.

The exported CSVs in fabrication/ came from a 2023 revision of the board and no
longer match the schematic. Reading the layout instead keeps the parts list
honest: it always describes the board as it is now.

    python hardware/tools/gen_bom.py            # markdown table on stdout
    python hardware/tools/gen_bom.py --csv      # csv instead
    python hardware/tools/gen_bom.py --write    # rewrite docs/bom.md

Grouping is by (value, footprint), which is what a fab house quotes against.
"""
import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

PCB = Path(__file__).resolve().parents[1] / 'octobot-controller.kicad_pcb'
OUT = Path(__file__).resolve().parents[2] / 'docs' / 'bom.md'

# Reference prefix -> what the part does. Anything unlisted falls back to "".
ROLE = {
    'C': 'Capacitor', 'R': 'Resistor', 'L': 'Inductor', 'D': 'Diode / LED',
    'Q': 'Transistor', 'Y': 'Crystal', 'U': 'IC / module', 'IC': 'IC',
    'J': 'Connector', 'S': 'Switch', 'SW': 'Switch', 'LS': 'Buzzer',
}


def footprint_blocks(text):
    """Yield each top-level (footprint ...) s-expression as a string."""
    i = 0
    while True:
        i = text.find('\n  (footprint ', i)
        if i < 0:
            return
        depth, j = 0, i
        while True:
            ch = text[j]
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        yield text[i:j + 1]
        i = j


def parse(pcb_path):
    text = pcb_path.read_text(encoding='utf8', errors='replace')
    parts = []
    for block in footprint_blocks(text):
        ref = re.search(r'\(fp_text reference "([^"]+)"', block)
        val = re.search(r'\(fp_text value "([^"]+)"', block)
        fpm = re.match(r'\s*\(footprint "([^"]+)"', block)
        if not (ref and val and fpm):
            continue
        designator = ref.group(1)
        if designator.startswith(('REF', 'G')):     # fiducials, logos, graphics
            continue
        parts.append({
            'ref': designator,
            'value': val.group(1),
            'footprint': fpm.group(1).split(':')[-1],
            'nets': sorted({n for n in re.findall(r'\(net \d+ "([^"]*)"\)', block) if n}),
        })
    return parts


def sort_key(ref):
    m = re.match(r'([A-Za-z]+)(\d+)', ref)
    return (m.group(1), int(m.group(2))) if m else (ref, 0)


def group(parts):
    buckets = defaultdict(list)
    for p in parts:
        buckets[(p['value'], p['footprint'])].append(p['ref'])
    rows = []
    for (value, footprint), refs in buckets.items():
        prefix = re.match(r'([A-Za-z]+)', refs[0]).group(1)
        rows.append({
            'qty': len(refs),
            'value': value,
            'footprint': footprint,
            'refs': ', '.join(sorted(refs, key=sort_key)),
            'role': ROLE.get(prefix, ''),
        })
    rows.sort(key=lambda r: (r['role'] == 'Resistor', r['role'] == 'Capacitor',
                             -r['qty'], r['value']))
    return rows


def as_markdown(rows, total):
    out = ['| Qty | Value | Footprint | Designators |',
           '|---:|---|---|---|']
    for r in rows:
        refs = r['refs'] if len(r['refs']) <= 90 else r['refs'][:87] + '...'
        out.append(f"| {r['qty']} | `{r['value']}` | {r['footprint']} | {refs} |")
    out.append('')
    out.append(f'**{total} placements, {len(rows)} distinct lines.**')
    return '\n'.join(out)


def as_csv(rows):
    out = ['Qty,Value,Footprint,Designators']
    for r in rows:
        out.append(f"{r['qty']},\"{r['value']}\",\"{r['footprint']}\",\"{r['refs']}\"")
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', action='store_true', help='emit CSV instead of markdown')
    ap.add_argument('--write', action='store_true', help='rewrite docs/bom.md')
    args = ap.parse_args()

    if not PCB.exists():
        sys.exit(f'no PCB at {PCB}')
    parts = parse(PCB)
    rows = group(parts)

    if args.csv:
        print(as_csv(rows))
        return

    table = as_markdown(rows, len(parts))
    if not args.write:
        print(table)
        return

    header = (
        '# Bill of materials\n\n'
        '**Generated from `hardware/octobot-controller.kicad_pcb` by\n'
        '`hardware/tools/gen_bom.py`. Do not edit by hand.**\n\n'
        'The CSVs in `hardware/fabrication/` were exported in 2023 and describe an\n'
        'earlier board. This table is read from the current layout, so it stays\n'
        'correct as the board changes. Regenerate it with:\n\n'
        '```bash\n'
        'python hardware/tools/gen_bom.py --write\n'
        '```\n\n'
        'LCSC part numbers are not tracked in the layout, so the fab house needs a\n'
        'populated CSV before assembly. Export that from KiCad at order time.\n\n'
        '---\n\n'
    )
    OUT.write_text(header + table + '\n', encoding='utf8')
    print(f'wrote {OUT} ({len(parts)} placements, {len(rows)} lines)')


if __name__ == '__main__':
    main()
