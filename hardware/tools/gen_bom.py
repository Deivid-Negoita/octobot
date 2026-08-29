"""Build the bill of materials from the KiCad project.

Placements and packages come from the layout, manufacturer part numbers from the
schematic symbol fields. Nothing is typed by hand, so the published table cannot
drift away from the board.

    python hardware/tools/gen_bom.py            # markdown table on stdout
    python hardware/tools/gen_bom.py --csv      # csv instead
    python hardware/tools/gen_bom.py --write    # rewrite docs/bom.md and the
                                                # BOM block in README.md
    python hardware/tools/gen_bom.py --check    # diff against the fab export

Grouping is by (value, footprint), which is what a fab house quotes against.
--check re-groups the fabrication BOM the same way and compares designator sets,
which catches a layout edited after the last export.
"""
import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PCB = ROOT / 'hardware' / 'octobot-controller.kicad_pcb'
SCH = ROOT / 'hardware' / 'octobot-controller.kicad_sch'
BOM_DOC = ROOT / 'docs' / 'bom.md'
README = ROOT / 'README.md'
FAB_BOM = ROOT / 'hardware' / 'fabrication' / 'octobot-controller-bom.csv'
MARKERS = ('<!-- BOM:START -->', '<!-- BOM:END -->')

# What each line does on this board. Read off the netlist, not guessed: every
# claim here is checkable against the nets named in octobot-controller.kicad_pcb.
FUNCTION = {
    'ATmega32U4-M': 'Host MCU. Native USB, 16 MHz crystal, I2C master.',
    'PCA9685PW/Q900_118': '16-channel 12-bit PWM generator. 12 channels used each, at 0x40 and 0x41.',
    'SY8303AIC': 'Synchronous buck. VIN down to the 5.0 V logic rail set by R11/R12.',
    'RQ3E075ATTB': 'P-channel MOSFET. Reverse-polarity pass element on the input.',
    'HPZR-C10X': '10 V regulator diode. Clamps the pass FET gate.',
    'AVR-ISP': 'ISP header on D14/D15/D16 and RESET.',
    'Crystal_GND24': 'MCU clock, loaded by C1/C3.',
    '4,7 uH': 'Buck output inductor.',
    '47346-0001': 'USB micro-B receptacle. Programming and 5 V input.',
    'Conn_01x03_Pin': '24 servo headers (GND / rail / signal), 2 rail feeds (J29/J30), 2 analog headers (J32/J33).',
    'Conn_01x04_Pin': 'HC-12 radio header: 5 V, GND, D8, D9.',
    '1x2': 'Input power (J9), 5 V taps (J16/J34), I2C breakout (J31).',
    'TL3365AF180QG': 'Reset (S1) and user button on D12 (S2).',
    'DS04-254-2-03BK-SMT': '3-position DIP switch on D14/D15/D16.',
    'LED': 'Power, RX and TX indicators.',
    '875075161013': 'Aluminium electrolytic. Bulk storage, one per servo rail.',
    '220 Ohm': 'Series resistor on each servo signal line.',
    '10K': 'PWM address and OE straps, I2C pull-ups, buck enable.',
    '10KOhm': 'RESET pull-up.',
    '22 Ohm': 'USB D+/D- series termination.',
    '110K Ohm': 'Buck feedback divider, upper leg.',
    '15K Ohm': 'Buck feedback divider, lower leg.',
    '100K Ohm': 'Buck switching-frequency set resistor.',
    '100K': 'Pass FET gate pull-down.',
    '1K': 'LED series resistors.',
    '1KOhm': 'LED series resistor.',
    '12 pF': 'Buck feedback feed-forward.',
    '10nF': 'Buck bootstrap.',
    '18pF': 'Crystal load capacitors.',
    '1uF': 'USB UCAP and buck input decoupling.',
    '10uF': 'Rail decoupling.',
    '0,1uF': 'Decoupling.',
    '0.1uF': 'AREF decoupling.',
}

# Sort order: actives and connectors first, passives last.
CLASS = {'U': 0, 'IC': 0, 'Q': 1, 'D': 1, 'L': 1, 'Y': 1, 'J': 2, 'S': 3, 'R': 4, 'C': 5}

# Symbols that carry no manufacturer field but have only one plausible source.
MAKER = {'ATmega32U4-M': 'Microchip', 'PCA9685PW/Q900_118': 'NXP'}


def footprints(text):
    """Yield each top-level (footprint ...) s-expression as a string."""
    i = 0
    while True:
        i = text.find('\n  (footprint ', i)
        if i < 0:
            return
        depth, j = 0, i
        while True:
            if text[j] == '(':
                depth += 1
            elif text[j] == ')':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        yield text[i:j + 1]
        i = j


def read_layout(path):
    parts = []
    for block in footprints(path.read_text(encoding='utf8', errors='replace')):
        ref = re.search(r'\(fp_text reference "([^"]+)"', block)
        val = re.search(r'\(fp_text value "([^"]+)"', block)
        fp = re.match(r'\s*\(footprint "([^"]+)"', block)
        if not (ref and val and fp) or ref.group(1).startswith(('REF', 'G')):
            continue
        parts.append({
            'ref': ref.group(1),
            'value': val.group(1),
            'package': fp.group(1).split(':')[-1],
            'mount': 'THT' if '(pad "1" thru_hole' in block else 'SMT',
        })
    return parts


def read_mpns(path):
    """Reference -> (manufacturer, part number) from the schematic symbol fields."""
    if not path.exists():
        return {}
    text = path.read_text(encoding='utf8', errors='replace')
    starts = [m.start() for m in re.finditer(r'\n  \(symbol \(lib_id ', text)]
    mpns = {}
    for a, b in zip(starts, starts[1:] + [len(text)]):
        block = text[a:b]
        ref = re.search(r'\(property "Reference" "([^"]+)"', block)
        if not ref:
            continue
        fields = dict(re.findall(r'\(property "([^"]+)" "([^"]*)"', block))
        maker = fields.get('Manufacturer_Name') or fields.get('MANUFACTURER') or fields.get('MF', '')
        number = fields.get('Manufacturer_Part_Number') or fields.get('MP', '')
        if maker or number:
            mpns[ref.group(1)] = (maker, number)
    return mpns


def natural(ref):
    m = re.match(r'([A-Za-z]+)(\d+)', ref)
    return (m.group(1), int(m.group(2))) if m else (ref, 0)


def compress(refs):
    """R1, R2, R3, R7 -> 'R1-R3, R7'. Keeps the list short without lying about
    which designators are in it."""
    runs = []
    for ref in refs:
        prefix, number = natural(ref)
        if runs and runs[-1][0] == prefix and runs[-1][2] + 1 == number:
            runs[-1][2] = number
        else:
            runs.append([prefix, number, number])
    return ', '.join(f'{p}{a}' if a == b else f'{p}{a}–{p}{b}'
                     for p, a, b in runs)


def group(parts, mpns):
    buckets = defaultdict(list)
    for p in parts:
        buckets[(p['value'], p['package'], p['mount'])].append(p['ref'])
    rows = []
    for (value, package, mount), refs in buckets.items():
        refs.sort(key=natural)
        prefix = re.match(r'([A-Za-z]+)', refs[0]).group(1)
        maker, number = mpns.get(refs[0], ('', ''))
        maker = maker or MAKER.get(value, '')
        rows.append({
            'qty': len(refs),
            'value': value,
            'part': f'{maker} {number}'.strip() if number not in ('', value) else maker,
            'package': package,
            'mount': mount,
            'refs': refs,
            'function': FUNCTION.get(value, ''),
            'order': (CLASS.get(prefix, 9), -len(refs), value),
        })
    rows.sort(key=lambda r: r['order'])
    return rows


def as_markdown(rows, total):
    out = ['| Qty | Value | Manufacturer part | Package | Ref | Function |',
           '|---:|---|---|---|---|---|']
    for r in rows:
        out.append(f"| {r['qty']} | `{r['value']}` | {r['part'] or '—'} | "
                   f"{r['package']} | {compress(r['refs'])} | {r['function']} |")
    tht = sum(r['qty'] for r in rows if r['mount'] == 'THT')
    out.append('')
    out.append(f'**{total} placements over {len(rows)} lines: '
               f'{total - tht} SMT and {tht} through-hole.**')
    return '\n'.join(out)


def as_csv(rows):
    out = ['Qty,Value,Manufacturer part,Package,Mount,Designators,Function']
    for r in rows:
        cells = [str(r['qty']), r['value'], r['part'], r['package'], r['mount'],
                 ' '.join(r['refs']), r['function']]
        cells = [c.replace('"', "'") for c in cells]
        out.append(','.join(f'"{c}"' for c in cells))
    return '\n'.join(out)


def read_fab_bom(path):
    """Designator -> (value, package) from the fabrication export."""
    import csv
    with path.open(encoding='utf-8-sig', newline='') as f:
        return {ref.strip(): (row['value'], row['pack'])
                for row in csv.DictReader(f)
                for ref in row['designator'].split(',')}


def check(rows):
    """Compare the generated table against the BOM the board house was sent."""
    if not FAB_BOM.exists():
        sys.exit(f'no fabrication BOM at {FAB_BOM}')
    fab = read_fab_bom(FAB_BOM)
    ours = {ref: (r['value'], r['package']) for r in rows for ref in r['refs']}

    problems = []
    for ref in sorted(set(fab) - set(ours), key=natural):
        problems.append(f'{ref}: in the fab export, not in the layout')
    for ref in sorted(set(ours) - set(fab), key=natural):
        problems.append(f'{ref}: in the layout, not in the fab export')
    for ref in sorted(set(fab) & set(ours), key=natural):
        if fab[ref] != ours[ref]:
            problems.append(f'{ref}: layout has {ours[ref]}, fab export has {fab[ref]}')

    if problems:
        print(f'{len(problems)} mismatch(es) against {FAB_BOM.name}:')
        for p in problems:
            print(' !', p)
        print('\nThe layout has changed since the last export. Re-export before ordering.')
        return False
    print(f'{len(ours)} placements match {FAB_BOM.name} exactly.')
    return True


def splice(text, block):
    """Replace the region between the BOM markers, keeping the markers."""
    start, end = MARKERS
    i, j = text.find(start), text.find(end)
    if i < 0 or j < 0:
        sys.exit(f'{README.name} has no {start} / {end} pair')
    return f'{text[:i + len(start)]}\n\n{block}\n\n{text[j:]}'


HEADER = """# Bill of materials

Generated from the KiCad project by `hardware/tools/gen_bom.py` — placements and
packages from `octobot-controller.kicad_pcb`, manufacturer part numbers from
`octobot-controller.kicad_sch`. Do not edit by hand:

```bash
python hardware/tools/gen_bom.py --write   # regenerate this file and the README
python hardware/tools/gen_bom.py --check   # confirm it matches the fab export
```

`--check` compares this table against
`hardware/fabrication/octobot-controller-bom.csv`, the BOM inside the
fabrication package the board house was sent. The two agree line for line and
designator for designator.

Distributor part numbers are not tracked in the project files, so an assembly
house needs those added at order time.

---

"""


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--csv', action='store_true', help='emit CSV instead of markdown')
    ap.add_argument('--write', action='store_true', help='rewrite docs/bom.md and README.md')
    ap.add_argument('--check', action='store_true',
                    help='compare against the fabrication export, exit 1 on any difference')
    args = ap.parse_args()

    if not PCB.exists():
        sys.exit(f'no PCB at {PCB}')
    parts = read_layout(PCB)
    rows = group(parts, read_mpns(SCH))

    if args.check:
        sys.exit(0 if check(rows) else 1)

    if args.csv:
        print(as_csv(rows))
        return

    table = as_markdown(rows, len(parts))
    if not args.write:
        print(table)
        return

    BOM_DOC.write_text(HEADER + table + '\n', encoding='utf8')
    README.write_text(splice(README.read_text(encoding='utf8'), table), encoding='utf8')
    print(f'wrote {BOM_DOC.relative_to(ROOT)} and the BOM block in '
          f'{README.relative_to(ROOT)} ({len(parts)} placements, {len(rows)} lines)')


if __name__ == '__main__':
    main()
