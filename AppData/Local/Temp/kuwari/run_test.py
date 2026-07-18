# -*- coding: utf-8 -*-
import sys, time
sys.path.insert(0, r'C:\Users\s1\AppData\Local\Temp\kuwari')
from partition_cpp import run_cpp

for pref, m in [('青森県', 3), ('山形県', 3)]:
    print(f"--- {pref} m={m} ---", flush=True)
    t0 = time.perf_counter()
    r = run_cpp(pref, m)
    print(f"elapsed: {time.perf_counter()-t0:.1f}s", flush=True)
    if r:
        print(r)
