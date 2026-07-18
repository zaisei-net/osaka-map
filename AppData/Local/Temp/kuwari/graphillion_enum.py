# graphillion_enum.py  v3
# 改善点:
#   - 辺順: DFS順（tree edges → back edges）でフロンティアを最小化
#   - segfault対策: 解数>MAX_ITER ではサンプリング近似
#   - 結果: results.json に都度追記

import sys, os, json, time, math
import pandas as pd
sys.stdout.reconfigure(encoding="utf-8")

from graphillion import GraphSet

BASE  = os.path.join(r"C:\Users\s1\AppData\Local\Temp\kuwari", "kuwari")
OUT   = os.path.join(r"C:\Users\s1\AppData\Local\Temp\kuwari", "results.json")
L     = 258537
U     = L * 2      # 517074（未満）
MAX_ITER = 100_000  # これを超えたらサンプリング

FERRY = {
    "島根県":   [("海士町","松江市"),("西ノ島町","松江市"),("知夫村","松江市"),("隠岐の島町","松江市")],
    "和歌山県": [("北山村","新宮市")],
    "香川県":   [("直島町","高松市"),("土庄町","高松市"),("小豆島町","高松市")],
    "愛媛県":   [("上島町","今治市")],
    "長崎県":   [("対馬市","壱岐市"),("壱岐市","佐世保市"),
                 ("五島市","長崎市"),("小値賀町","佐世保市"),("新上五島町","佐世保市")],
    "大分県":   [("姫島村","国東市")],
    "新潟県":   [("佐渡市","新潟市中央区"),("粟島浦村","村上市")],
    "広島県":   [("大崎上島町","竹原市")],
    "鹿児島県": [("三島村","薩摩川内市"),("十島村","薩摩川内市"),
                 ("屋久島町","南大隅町"),("西之表市","鹿屋市"),
                 ("喜界町","奄美市"),("奄美市","鹿児島市"),
                 ("天城町","瀬戸内町"),("知名町","伊仙町"),("与論町","知名町")],
    "沖縄県":   [("伊平屋村","今帰仁村"),("伊是名村","今帰仁村"),("伊江村","本部町"),
                 ("渡嘉敷村","那覇市"),("座間味村","那覇市"),("渡名喜村","那覇市"),
                 ("粟国村","那覇市"),("久米島町","那覇市"),
                 ("北大東村","那覇市"),("南大東村","那覇市"),
                 ("宮古島市","那覇市"),("多良間村","宮古島市"),
                 ("石垣市","那覇市"),("竹富町","石垣市"),("与那国町","石垣市")],
}
ALIAS = {
    "高知県": {"檮原町": "梼原町"},
}

# 大都市を2仮想ノード(A/B)に分割する県設定
# 人口は均等2分割; A・Bはお互いに隣接 + 元の隣接市全てに接続
SPLIT_CITY = {
    "富山県": "富山市",
    "石川県": "金沢市",
    "香川県": "高松市",
    "鹿児島県": "鹿児島市",  # 577,049 > U
    "静岡県": "浜松市中央区",  # 2024年区再編で7区→1区 568,617 > U
}

# ── データ読み込み ────────────────────────────────────────────
_pop_df = _adj_df = None

def load_data():
    global _pop_df, _adj_df
    if _pop_df is None:
        _pop_df = pd.read_excel(os.path.join(BASE,"R7_population.xlsx"), engine="openpyxl")
        _pop_df.columns = ["pref_code","pref","muni_code","muni","type","total","foreign","japanese"]
        _adj_df = pd.read_excel(os.path.join(BASE,"adjacency.xlsx"), engine="openpyxl")
        _adj_df.columns = ["pref","seq","muni","ward","sea","adj_n","ward_adj_n","adj_all","adj_pref"]
    return _pop_df, _adj_df


def build_graph(pref_name):
    pop_df, adj_df = load_data()

    p = pop_df[pop_df["pref"]==pref_name].copy()
    p["node"] = p["muni"].astype(str).str.strip()
    alias = ALIAS.get(pref_name, {})
    p["node"] = p["node"].map(lambda x: alias.get(x, x))
    # adj_dfのward列（短縮区名）→ pop_dfのmuni完全名 マッピング
    # adj_dfのward行から直接ルックアップして endswith衝突(江南区 vs 南区)を回避
    ward_map = {}
    a_tmp = adj_df[adj_df["pref"]==pref_name]
    ward_rows = p[p["type"] == "行政区"]
    for _, arow in a_tmp[a_tmp["ward"].notna()].iterrows():
        w = str(arow["ward"]).strip()
        if w and w not in ward_map:
            # adj_dfのward名と完全一致するpop_dfのmuni行を探す
            # muni形式は「市名+ward名」なので末尾がwと一致するものを選ぶ
            # ただし「江南区」は「南区」より長いのでexactサフィックスが必要
            match = ward_rows[ward_rows["node"].str.endswith(w) &
                              (ward_rows["node"].str.len() - len(w) > 0)]
            if len(match) == 1:
                ward_map[w] = match.iloc[0]["node"]
            elif len(match) > 1:
                # 最短のmuni名（市名+w）を優先: 長い末尾より短い末尾の誤マッチを避ける
                ward_map[w] = match.loc[match["node"].str.len().idxmin(), "node"]

    pop_dict = {r["node"]: int(r["japanese"]) for _, r in p.iterrows()}

    # 行政区がある政令市の市レベルエントリを除外（重複・U超え防止）
    # 例: pop_dictに「仙台市」と「仙台市青葉区」が両方ある場合、「仙台市」を除外
    ward_city_prefixes = set()
    for full_name in ward_rows["node"]:
        for city in list(pop_dict.keys()):
            if str(full_name).startswith(city) and str(full_name) != city:
                ward_city_prefixes.add(city)
    for city in ward_city_prefixes:
        pop_dict.pop(city, None)

    a = adj_df[adj_df["pref"]==pref_name].copy()
    def lbl(r):
        if pd.notna(r["ward"]):
            w = str(r["ward"]).strip()
            return ward_map.get(w, w)  # 短縮名をフル名に変換
        return str(r["muni"]).strip()
    a["node"] = a.apply(lbl, axis=1)

    adj = {n: set() for n in pop_dict}
    for _, r in a.iterrows():
        node = r["node"]; raw = r["adj_pref"]
        if pd.isna(raw) or not str(raw).strip(): continue
        for nb in str(raw).strip().split():
            nb = ward_map.get(nb, nb)  # 区短縮名をフル名に変換
            if node in adj: adj[node].add(nb)
            if nb in adj:   adj[nb].add(node)
            else:            adj[nb] = {node}

    for isl, prt in FERRY.get(pref_name, []):
        if isl in adj and prt in adj:
            adj[isl].add(prt); adj[prt].add(isl)

    # 分割市: 大都市を A/B 2ノードに置き換え
    split_city = SPLIT_CITY.get(pref_name)
    if split_city and split_city in pop_dict:
        city_pop = pop_dict[split_city]
        city_neighbors = adj.pop(split_city, set())
        pop_dict.pop(split_city)
        pa = city_pop // 2
        pb = city_pop - pa
        na = split_city + "_A"
        nb_name = split_city + "_B"
        pop_dict[na] = pa
        pop_dict[nb_name] = pb
        adj[na] = set(city_neighbors) | {nb_name}
        adj[nb_name] = set(city_neighbors) | {na}
        for nb in city_neighbors:
            if nb in adj:
                adj[nb].discard(split_city)
                adj[nb].add(na)
                adj[nb].add(nb_name)

    nodes = sorted(pop_dict.keys())
    return nodes, pop_dict, adj


# ── 辺順: DFS順（tree edges → back edges） ───────────────────
def dfs_edge_order(nodes, adjacency):
    visited = set()
    tree_edges = []
    back_edges = []
    tree_set = set()

    def dfs(u):
        visited.add(u)
        for v in sorted(adjacency.get(u, [])):
            if v not in visited:
                e = (u, v) if u < v else (v, u)
                tree_edges.append(e); tree_set.add(e)
                dfs(v)
            else:
                e = (u, v) if u < v else (v, u)
                if e not in tree_set and e not in back_edges:
                    back_edges.append(e)

    for start in sorted(nodes):
        if start not in visited:
            dfs(start)

    return tree_edges + back_edges


def setup_universe(nodes, pop_dict, adj):
    """DFS辺順でユニバース設定。weight_list, node_idx, 孤立ノードを返す。"""
    node_idx = {nd: i+1 for i, nd in enumerate(nodes)}
    dfs_edges = dfs_edge_order(nodes, adj)
    # node_idx に変換
    edges = [(node_idx[u], node_idx[v]) for u, v in dfs_edges
             if u in node_idx and v in node_idx]
    GraphSet.set_universe(edges)
    weight_list = {node_idx[nd]: pop_dict[nd] for nd in nodes}
    adj_verts = set()
    for e in edges: adj_verts.add(e[0]); adj_verts.add(e[1])
    isolated = [nd for nd in nodes if node_idx[nd] not in adj_verts]
    return weight_list, node_idx, edges, isolated


# ── 格差計算ユーティリティ ────────────────────────────────────
def calc_ratio_from_edgeset(edge_set, weight_list, all_verts):
    parent = {v: v for v in all_verts}
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for (u, v) in edge_set:
        pu, pv = find(u), find(v)
        if pu != pv: parent[pu] = pv
    comps = {}
    for v in all_verts:
        comps.setdefault(find(v), []).append(v)
    pops = sorted(sum(weight_list[v] for v in comp) for comp in comps.values())
    return pops[-1] / pops[0], pops


def find_best_ratio(gs, weight_list, n_solutions, all_verts):
    """
    解数が MAX_ITER 以下なら全イテレーション、超えたらサンプリング近似。
    """
    import itertools
    is_approx = n_solutions > MAX_ITER
    sample_size = MAX_ITER if is_approx else n_solutions

    best_r = float("inf"); best_pops = None
    for edge_set in itertools.islice(gs, sample_size):
        r, pops = calc_ratio_from_edgeset(edge_set, weight_list, all_verts)
        if r < best_r:
            best_r = r; best_pops = pops
    return best_r, best_pops, is_approx


# ── メイン列挙関数 ────────────────────────────────────────────
def enum_pref(pref_name, m, tottori_mode=False, compute_ratio=True):
    nodes, pop_dict, adj = build_graph(pref_name)
    total = sum(pop_dict.values())
    n = len(nodes)

    weight_list, node_idx, edges, isolated = setup_universe(nodes, pop_dict, adj)
    all_verts = set(node_idx.values())

    if isolated:
        print(f"  警告: 孤立ノード {isolated}", flush=True)

    t0 = time.perf_counter()

    if tottori_mode:
        third = total // 3
        gs_all   = GraphSet.balanced_partitions(weight_list=weight_list, ratio=2.0, num_comps=m, lower=1)
        gs_exact = GraphSet.balanced_partitions(weight_list=weight_list, ratio=2.0, num_comps=m,
                                                lower=third, upper=third)
        n_sol = len(gs_all) - len(gs_exact)
        gs_tgt = gs_all  # ratio<2 は差分だが格差探索は gs_all で近似
    else:
        gs_tgt = GraphSet.balanced_partitions(weight_list=weight_list, num_comps=m, lower=L, upper=U-1)
        n_sol = len(gs_tgt)

    t_enum = time.perf_counter()

    best_ratio = None; best_pops = None; is_approx = False
    if compute_ratio and n_sol > 0:
        best_ratio, best_pops, is_approx = find_best_ratio(
            gs_tgt, weight_list, n_sol, all_verts)

    elapsed = time.perf_counter() - t0

    # ノード名逆引き
    idx_node = {v: nd for nd, v in node_idx.items()}
    best_partition = None
    if best_pops is not None:
        # 最後に見た edge_set を使って成分を構築（find_best_ratio の内部で捨てているので再取得）
        pass  # 後で必要なら追加

    result = {
        "pref":         pref_name,
        "m":            m,
        "n_nodes":      n,
        "n_edges":      len(edges),
        "n_solutions":  n_sol,
        "best_ratio":   round(best_ratio, 6) if best_ratio and not math.isinf(best_ratio) else None,
        "best_pops":    best_pops,
        "is_approximate": is_approx,
        "elapsed_sec":  round(elapsed, 3),
        "tottori_mode": tottori_mode,
    }
    return result


# ── JSON保存 ─────────────────────────────────────────────────
def save_result(result, path=OUT):
    data = []
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            try: data = json.load(f)
            except: data = []
    # 既存エントリを上書き（同じ pref+m のもの）
    data = [d for d in data if not (d["pref"]==result["pref"] and d["m"]==result["m"])]
    data.append(result)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def run(pref_name, m, tottori_mode=False, compute_ratio=True):
    print(f"  {pref_name} m={m} ...", end=" ", flush=True)
    try:
        r = enum_pref(pref_name, m, tottori_mode=tottori_mode, compute_ratio=compute_ratio)
        approx_mark = "~" if r["is_approximate"] else ""
        ratio_str = f"{approx_mark}{r['best_ratio']:.4f}" if r["best_ratio"] else "N/A"
        print(f"解数={r['n_solutions']:,}  after={ratio_str}  ({r['elapsed_sec']:.1f}s)")
        save_result(r)
        return r
    except Exception as e:
        print(f"ERROR: {e}")
        return None


# ── メイン ───────────────────────────────────────────────────
if __name__ == "__main__":

    # 検算
    print("=== 検算 ===")
    verify = [
        ("鳥取県", 2, True,  58,   1.0051),
        ("島根県", 2, False,  6,   1.0310),
        ("徳島県", 2, False, 2194, 1.0005),
        ("高知県", 2, False,  24,  1.0738),
        ("滋賀県", 3, False, 1843, 1.0185),
    ]
    all_ok = True
    for pref, m, tmode, exp_c, exp_r in verify:
        r = run(pref, m, tmode)
        if r:
            ok_c = r["n_solutions"] == exp_c
            ok_r = abs((r["best_ratio"] or 0) - exp_r) < 0.001
            all_ok = all_ok and ok_c
            if not ok_c: print(f"    NG: expected {exp_c}")
            if not ok_r: print(f"    ratio NG: expected {exp_r}, got {r['best_ratio']}")

    print()
    if not all_ok:
        print("検算失敗。中断。"); sys.exit(1)
    print("全検算パス。")
    print()

    # 第1バッチ: 2議席（確定済み）
    print("=== 第1バッチ: 2議席県 ===")
    for pref in ["福井県","山梨県","和歌山県","佐賀県"]:
        run(pref, 2)

    print()

    # 第2バッチ: 3議席・問題少
    print("=== 第2バッチ: 3議席（問題少） ===")
    batch2 = ["大分県","宮崎県","富山県","石川県","秋田県","岩手県","山口県","愛媛県","長崎県"]
    for pref in batch2:
        run(pref, 3)

    print()

    # 第3バッチ: 3議席・要注意
    print("=== 第3バッチ: 3議席（要注意） ===")
    batch3 = ["青森県","山形県","奈良県","滋賀県"]  # 三重はm=4なので除外
    for pref in batch3:
        run(pref, 3)

    print()

    # 第4バッチ: 4議席
    print("=== 第4バッチ: 4議席 ===")
    batch4 = ["三重県","岡山県","熊本県","福島県","鹿児島県","沖縄県","滋賀県"]
    for pref in batch4:
        run(pref, 4)

    print()

    # 第5バッチ: 5議席
    print("=== 第5バッチ: 5議席 ===")
    batch5 = ["新潟県","栃木県","群馬県","岐阜県","長野県","宮城県"]
    for pref in batch5:
        run(pref, 5)

    print()

    # 第6バッチ: 6議席
    print("=== 第6バッチ: 6議席 ===")
    for pref in ["京都府","広島県"]:
        run(pref, 6)

    print()

    # 第7バッチ: 7-8議席
    print("=== 第7バッチ: 7-8議席 ===")
    run("茨城県", 7)
    run("静岡県", 8)

    print()

    # 第8バッチ: 11-12議席（大規模）
    print("=== 第8バッチ: 11-12議席 ===")
    run("北海道", 11)
    run("兵庫県", 12)
    run("福岡県", 12)

    print()

    # 第9バッチ: 14-20議席（超大規模・近似）
    print("=== 第9バッチ: 14-20議席（近似） ===")
    run("千葉県", 14)
    run("埼玉県", 16)
    run("愛知県", 16)
    run("大阪府", 19)
    run("神奈川県", 20)

    print()

    # 第10バッチ: 東京（m=31・超近似）
    print("=== 第10バッチ: 東京 m=31 ===")
    run("東京都", 31)

    print()
    print("=== 完了 ===")
    print(f"結果: {OUT}")
