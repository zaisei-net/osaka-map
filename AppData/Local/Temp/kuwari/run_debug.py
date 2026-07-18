# -*- coding: utf-8 -*-
import sys, os, subprocess, time
sys.path.insert(0, r'C:\Users\s1\AppData\Local\Temp\kuwari')
from graphillion_enum import build_graph, setup_universe, L, U

pref = '青森県'
m = 3
nodes, pop_dict, adj = build_graph(pref)
weight_list, node_idx, edges, isolated = setup_universe(nodes, pop_dict, adj)

n = len(node_idx)
me = len(edges)
print(f"N={n} M={me} K={m}", flush=True)

wvec = [0] * n
for ni, w in weight_list.items():
    wvec[ni - 1] = w

lines = [f"{n} {me} {m} {L} {U}"]
lines.append(" ".join(map(str, wvec)))
for u, v in edges:
    lines.append(f"{u-1} {v-1}")
stdin_data = "\n".join(lines) + "\n"

EXE = r"C:\Users\s1\AppData\Local\Temp\kuwari\enumpart.exe"
t0 = time.perf_counter()
proc = subprocess.run([EXE], input=stdin_data.encode("ascii"),
                      capture_output=True, timeout=600)
elapsed = time.perf_counter() - t0
print(f"exit={proc.returncode} elapsed={elapsed:.1f}s", flush=True)
print("STDOUT:", proc.stdout.decode("utf-8", errors="replace"), flush=True)
print("STDERR:", proc.stderr.decode("utf-8", errors="replace"), flush=True)
