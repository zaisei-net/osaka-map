# -*- coding: utf-8 -*-
import sys
sys.path.insert(0, r'C:\Users\s1\AppData\Local\Temp\kuwari')
from graphillion_enum import build_graph, setup_universe, L, U

pref = sys.argv[1]
m = int(sys.argv[2])
nodes, pop_dict, adj = build_graph(pref)
weight_list, node_idx, edges, isolated = setup_universe(nodes, pop_dict, adj)

n = len(node_idx)
me = len(edges)
wvec = [0] * n
for ni, w in weight_list.items():
    wvec[ni - 1] = w

print(f"{n} {me} {m} {L} {U}")
print(" ".join(map(str, wvec)))
for u, v in edges:
    print(f"{u-1} {v-1}")
