"""
C++ partition_enum.exe を Python から呼び出すブリッジ。
graphillion_enum.py の run() の代替として OOM 問題のある大県に使用。
"""
import sys, os, subprocess, json, time
sys.stdout.reconfigure(encoding='utf-8')

EXE = os.path.join(os.path.dirname(__file__), "enumpart.exe")

def run_cpp(pref_name, m, out_file=None):
    """C++ エンジンで列挙し、結果を返す + results.json に保存"""
    sys.path.insert(0, os.path.dirname(__file__))
    from graphillion_enum import build_graph, setup_universe, L, U, OUT
    import json as _json

    nodes, pop_dict, adj = build_graph(pref_name)
    # setup_universe が内部で dfs_edge_order を呼び DFS順辺を返す
    weight_list, node_idx, edges, isolated = setup_universe(nodes, pop_dict, adj)

    n = len(node_idx)   # 頂点数
    me = len(edges)

    # weight_list は {1-indexed: weight} → 0-indexed wvec に変換
    wvec = [0] * n
    for ni, w in weight_list.items():
        wvec[ni - 1] = w

    # stdin 構築 (0-indexed で C++ に渡す)
    lines = [f"{n} {me} {m} {L} {U}"]
    lines.append(" ".join(map(str, wvec)))
    for u, v in edges:
        lines.append(f"{u-1} {v-1}")  # 1-indexed → 0-indexed
    stdin_data = "\n".join(lines) + "\n"

    t0 = time.perf_counter()
    proc = subprocess.run(
        [EXE],
        input=stdin_data.encode("ascii"),
        capture_output=True,
        timeout=3600
    )
    elapsed = time.perf_counter() - t0

    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", errors="replace")
        print(f"  {pref_name} m={m} C++エラー (exit {proc.returncode}): {stderr[:200]}")
        return None

    result = json.loads(proc.stdout.decode("utf-8"))
    n_sol = result["n_solutions"]
    best_ratio = result["best_ratio"]
    best_pops  = result["best_pops"]
    is_approx  = result["is_approximate"]
    zdd_nodes  = result["zdd_nodes"]

    approx_mark = "~" if is_approx else " "
    print(f"  {pref_name} m={m} ... 解数={n_sol:,}  ZDDノード={zdd_nodes:,}  "
          f"after={approx_mark}{best_ratio:.4f}  ({elapsed:.1f}s)")

    # results.json に保存
    entry = {
        "pref": pref_name, "m": m,
        "n_solutions": n_sol,
        "best_ratio": best_ratio,
        "best_pops": best_pops,
        "elapsed_sec": round(elapsed, 1),
        "is_approximate": is_approx,
        "engine": "cpp_tdzdd",
        "zdd_nodes": zdd_nodes,
    }
    if isolated:
        entry["isolated"] = isolated

    out = out_file or OUT
    try:
        with open(out, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = []
    data = [d for d in data if not (d["pref"] == pref_name and d["m"] == m)]
    data.append(entry)
    with open(out, "w", encoding="utf-8") as f:
        _json.dump(data, f, ensure_ascii=False, indent=2)

    return entry


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("pref")
    ap.add_argument("m", type=int)
    args = ap.parse_args()
    run_cpp(args.pref, args.m)
