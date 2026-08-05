/**
 * enumpart.cpp  -  connected balanced k-partition enumerator
 * Single-pass CombinedPartitionSpec: partition connectivity + weight constraints
 * integrated in one ZDD construction (vs slow 2-step build-then-filter).
 *
 * stdin:
 *   n_nodes n_edges k L U
 *   w_0 w_1 ... w_{n-1}        (0-indexed node weights)
 *   u v                        (edges, 0-indexed, one per line)
 * stdout (JSON):
 *   {"n_solutions":N,"zdd_nodes":Z,"best_ratio":R,"is_approximate":bool,"best_pops":[...]}
 */
#include "tdzdd/TdZdd-master/include/tdzdd/DdSpec.hpp"
#include "tdzdd/TdZdd-master/include/tdzdd/DdStructure.hpp"
#include "tdzdd/TdZdd-master/include/tdzdd/util/Graph.hpp"
#include <cstdio>
#include <cstring>
#include <vector>
#include <string>
#include <algorithm>
#include <numeric>
#include <functional>
#include <unordered_map>
#include <cassert>
#include <climits>
#include <cmath>
#include <limits>
using namespace std;

// ====== CombinedPartitionSpec ================================================
// Integrates k-partition connectivity (GraphPartitionSpec logic) with per-
// component weight constraints [lower, upper] (ComponentWeightSpec logic)
// into a SINGLE frontier-based ZDD construction pass.
//
// Design:
//   Scalar state: CombinedCount {comp_lb, comp_ub}
//   Array state:  CombinedMate[mateSize + fpsSize64]
//     [0..mateSize-1]    : linked list with int32 hoc (weight if head, else neg offset)
//     [mateSize..+fpsSize]: FPS bits stored as uint64 (reinterpreted from 8-byte CombinedMate)
//
// All vertices are uncolored; countUEC=false; noLoop=false.
// ============================================================================

struct CombinedCount {
  using count_t = int16_t;
  count_t comp_lb, comp_ub;
  CombinedCount(): comp_lb(1), comp_ub(numeric_limits<count_t>::max()) {}
  CombinedCount(count_t lb, count_t ub): comp_lb(lb), comp_ub(ub) {}
  size_t hash() const { return ((size_t)(uint16_t)comp_lb<<16)|(uint16_t)comp_ub; }
  bool operator==(CombinedCount const& o) const {
    return comp_lb==o.comp_lb && comp_ub==o.comp_ub; }
};

struct CombinedMate {
  typedef int32_t  Offset;
  typedef uint32_t uOffset;
  Offset hoc;  // weight (>=0) if head; negative offset to head otherwise
  Offset nxt;  // next in linked list (0 if tail)
  CombinedMate(Offset h=0): hoc(h), nxt(0) {}
  bool operator==(CombinedMate const& o) const { return this==&o; }
  bool operator!=(CombinedMate const& o) const { return this!=&o; }
  void clear() { hoc=0; nxt=0; }
  bool isHead()     const { return hoc>=0; }
  bool isTail()     const { return nxt==0; }
  bool isIsolated() const { return isHead()&&isTail(); }
  CombinedMate&       head()       { return isHead()?*this:*(this+hoc); }
  CombinedMate const& head() const { return isHead()?*this:*(this+hoc); }
  CombinedMate&       next()       { return *(this+nxt); }
  CombinedMate const& next() const { return *(this+nxt); }
  // Weight of the component this element belongs to (stored at head)
  int32_t getWeight() const { return head().hoc; }

  void mergeLists(CombinedMate& o1, CombinedMate& o2) {
    CombinedMate* p1=&o1.head(), *p2=&o2.head();
    if(p1==p2) return;
    if(p1>p2) swap(p1,p2);
    p1->hoc += p2->hoc; // accumulate weight at new head
    for(CombinedMate* q=p2;;q+=q->nxt){q->hoc=p1-q;if(q->nxt==0)break;}
    CombinedMate *p=p1, *q=p2;
    while(true){
      CombinedMate* pp=p+p->nxt;
      while(p<pp&&pp<q){p=pp;pp+=pp->nxt;}
      p->nxt=q-p; if(p==pp)break; p=q;q=pp; }
  }
  void replaceHeadWith(CombinedMate& nh) const {
    CombinedMate const* p=&head(); CombinedMate* q=&nh;
    q->hoc=p->hoc; // transfer weight
    while(q->nxt>0){q+=q->nxt; q->hoc=&nh-q;}
  }
  void removeFromList(CombinedMate const& o) {
    if(o.nxt==0){for(CombinedMate* p=this;p<=&o;++p)if(p+p->nxt==&o)p->nxt=0;}
    else        {for(CombinedMate* p=this;p<=&o;++p)if(p+p->nxt==&o)p->nxt+=o.nxt;}
  }
};

class CombinedPartitionSpec
    : public tdzdd::HybridDdSpec<CombinedPartitionSpec,CombinedCount,CombinedMate,2> {
  typedef CombinedCount Count;
  typedef CombinedMate  Mate;
  tdzdd::Graph const& graph;
  int const m, n, mateSize, fpsSize64; // fpsSize64 = extra Mate elements for FPS (each = 64 bits)
  int32_t const lower, upper;
  vector<Mate> initialMate;
  Count::count_t comp_lb, comp_ub;
  bool const lookahead;

  // FPS: bit matrix over mateSize×mateSize stored as uint64 array
  // Bit index for pair (v1<v2): p = -v1*(v1+3)/2 + v1*mateSize - 1 + v2
  // Stored in mate[mateSize..mateSize+fpsSize64-1] (reinterpreted as uint64_t[fpsSize64])

  void setF(int v1, int v2, Mate* mate, int val) const {
    if(v1>v2) swap(v1,v2);
    int p = -v1*(v1+3)/2 + v1*mateSize - 1 + v2;
    uint64_t* fps = reinterpret_cast<uint64_t*>(&mate[mateSize]);
    if(val) fps[p/64] |=  (1ULL<<(p%64));
    else    fps[p/64] &= ~(1ULL<<(p%64));
  }
  int getF(int v1, int v2, Mate const* mate) const {
    if(v1>v2) swap(v1,v2);
    int p = -v1*(v1+3)/2 + v1*mateSize - 1 + v2;
    uint64_t const* fps = reinterpret_cast<uint64_t const*>(&mate[mateSize]);
    return (fps[p/64] >> (p%64)) & 1ULL;
  }
  bool isInFPS(int v1, int v2, Mate const* mate) const { return getF(v1,v2,mate)!=0; }
  void addToFPS(int v1, int v2, Mate* mate) const { setF(v1,v2,mate,1); }
  // Merge FPS rows: union v2 into v1, clear v2
  void mergeFPS(int v1, int v2, Mate* mate) const {
    if(v1>v2) swap(v1,v2);
    for(int i=0;i<mateSize;++i){
      if(i==v1||i==v2) continue;
      if(getF(v2,i,mate)) setF(v1,i,mate,1);
      setF(v2,i,mate,0);
    }
  }
  // Transfer FPS row from v1 (old rep) to v2 (new rep); v2's row must be zero
  void changeRepFPS(int v1, int v2, Mate* mate) const {
    for(int i=0;i<mateSize;++i){
      if(i==v1||i==v2) continue;
      // assert(getF(v2,i,mate)==0);  // omit for speed
      setF(v2,i,mate,getF(v1,i,mate));
    }
  }
  // Shift FPS: new[i][j] = old[i+d][j+d], zeros for new entries
  void shiftFPS(int d, Mate* mate) const {
    for(int i=0;i<mateSize-1;++i){
      int j;
      for(j=i+1;j<mateSize-d;++j) setF(i,j,mate,getF(i+d,j+d,mate));
      for(;j<mateSize;++j)         setF(i,j,mate,0);
    }
  }

  // Check if the take path is valid; modifies c (Count) if a component closes
  bool takable(Count& c, Mate const* mate, tdzdd::Graph::EdgeInfo const& e) const {
    Mate const& w1=mate[e.v1-e.v0]; Mate const& w2=mate[e.v2-e.v0];
    int h1=int(&w1.head()-mate), h2=int(&w2.head()-mate);
    if(h1 != h2) {
      // Different components
      if(isInFPS(h1, h2, mate)) return false; // FPS: cannot merge
      int32_t merged = w1.getWeight() + w2.getWeight();
      if(merged > upper) return false; // merged weight too large
      if(e.v1final && e.v2final) {
        if(w1.isIsolated() && w2.isIsolated()) {
          // Both singletons merging and both closing: 1 component finalizes
          if(merged < lower) return false;
          if(c.comp_ub==0) return false;
          if(c.comp_ub>0) {c.comp_lb--;c.comp_ub--;}
        }
        // (Other cases: not both isolated and different components — component
        //  not fully closed yet since they just merged; stays open via next element)
      }
    } else {
      // Same component (noLoop=false: loop edge can be taken, no structural change)
      if(e.v1final && e.v2final) {
        // 2-element same-component [w1→w2] closing via a loop edge
        if(w1.isHead() && w2==w1.next() && w2.isTail()) {
          int32_t w = w1.getWeight();
          if(w < lower || w > upper) return false;
          if(c.comp_ub==0) return false;
          if(c.comp_ub>0) {c.comp_lb--;c.comp_ub--;}
        }
        // Larger same-component loops: component not fully closed by this edge alone
      }
    }
    if(e.finalEdge && c.comp_lb>0) return false;
    return true;
  }

  bool doTake(Count& count, Mate* mate, tdzdd::Graph::EdgeInfo const& e) const {
    Count c=count;
    if(!takable(c,mate,e)) return false;
    count=c;
    Mate& w1=mate[e.v1-e.v0]; Mate& w2=mate[e.v2-e.v0];
    int h1=int(&w1.head()-mate), h2=int(&w2.head()-mate);
    if(h1 != h2) {
      mergeFPS(h1, h2, mate);
      mate[0].mergeLists(w1, w2);
    }
    // Same component: no structural change needed
    return true;
  }

  bool doNotTake(Count& count, Mate* mate, tdzdd::Graph::EdgeInfo const& e) const {
    Mate& w1=mate[e.v1-e.v0]; Mate& w2=mate[e.v2-e.v0];
    int h1=int(&w1.head()-mate), h2=int(&w2.head()-mate);
    if(h1 == h2) return false; // noLoop=false: must take same-component edges
    Count c=count;
    addToFPS(h1, h2, mate);
    if(e.v1final && w1.isIsolated()) {
      if(w1.getWeight() < lower) return false; // singleton too light
      if(c.comp_ub>=0) {
        if(c.comp_ub==0) return false;
        c.comp_lb--; c.comp_ub--;
      }
    }
    if(e.v2final && w2.isIsolated()) {
      if(w2.getWeight() < lower) return false; // singleton too light
      if(c.comp_ub>=0) {
        if(c.comp_ub==0) return false;
        c.comp_lb--; c.comp_ub--;
      }
    }
    // Note: v1final&&v2final&&w1.isHead()&&w2==w1.next()&&w2.isTail()
    // is unreachable here because same-component → early return above
    if(e.finalEdge && c.comp_lb>0) return false;
    count=c;
    return true;
  }

  void update(Mate* mate, tdzdd::Graph::EdgeInfo const& e,
              tdzdd::Graph::EdgeInfo const& ee) const {
    int const d=ee.v0-e.v0; assert(d>=0);
    Mate* p1=&mate[e.v1-e.v0], *p2=&mate[e.v2-e.v0], *pd=p1+d;
    // For each element leaving the frontier window, transfer FPS/head to staying element
    for(Mate* q=p1; q<pd; ++q) {
      Mate* qq=&q->next();
      if(qq>=pd) {
        changeRepFPS(int(&q->head()-mate), int(qq-mate), mate);
        q->replaceHeadWith(*qq);
      }
    }
    if(d>0) shiftFPS(d, mate);
    if(e.v2final) {mate[0].removeFromList(*p2); p2->clear();}
    if(e.v1final) {mate[0].removeFromList(*p1); p1->clear();}
    if(d>0) {
      memmove(p1, pd, (mateSize-d)*sizeof(*mate));
      for(int i=mateSize-d; i<mateSize; ++i) p1[i]=initialMate[ee.v0+i];
    }
  }

 public:
  CombinedPartitionSpec(tdzdd::Graph const& graph,
                        vector<uint32_t> const& weights,
                        Count::count_t lb, Count::count_t ub,
                        int32_t lower, int32_t upper,
                        bool lookahead=true)
      : graph(graph), m(graph.vertexSize()), n(graph.edgeSize()),
        mateSize(graph.maxFrontierSize()),
        fpsSize64(((mateSize-1)*mateSize/2 + 63) / 64),
        lower(lower), upper(upper),
        initialMate(1+m+mateSize),
        comp_lb(lb), comp_ub(ub), lookahead(lookahead)
  {
    this->setArraySize(mateSize + fpsSize64);
    // weights[v-1] = weight of TdZdd vertex v (same indexing as ComponentWeightSpec)
    for(int v=1; v<=m; ++v) {
      initialMate[v] = Mate(Mate::Offset(weights[v-1]));
    }
  }

  int getRoot(Count& count, Mate* mate) const {
    int const v0=graph.edgeInfo(0).v0;
    count=Count{comp_lb,comp_ub};
    for(int i=0; i<mateSize; ++i) mate[i]=initialMate[v0+i];
    uint64_t* fps=reinterpret_cast<uint64_t*>(&mate[mateSize]);
    for(int i=0; i<fpsSize64; ++i) fps[i]=0;
    return n;
  }

  int getChild(Count& count, Mate* mate, int level, int take) const {
    assert(1<=level&&level<=n);
    int i=n-level;
    tdzdd::Graph::EdgeInfo const* e=&graph.edgeInfo(i);
    if(take) {if(!doTake(count,mate,*e)) return 0;}
    else     {if(!doNotTake(count,mate,*e)) return 0;}
    if(++i==n) return -1;
    tdzdd::Graph::EdgeInfo const* ee=&graph.edgeInfo(i);
    update(mate,*e,*ee);
    while(lookahead) {
      e=ee; Count c=count; if(takable(c,mate,*e)) break;
      if(!doNotTake(count,mate,*e)) return 0;
      if(++i==n) return -1;
      ee=&graph.edgeInfo(i); update(mate,*e,*ee);
    }
    assert(i<n); return n-i;
  }

  size_t hashCode(Count const& count) const { return count.hash(); }
};

// ====== main ================================================================

static const long long MAX_ITER = 100000LL;

int main() {
  int N,M,K; long long L_bound,U_bound;
  scanf("%d %d %d %lld %lld",&N,&M,&K,&L_bound,&U_bound);

  vector<long long> W64(N);
  vector<uint32_t>  W32(N);
  for(int i=0;i<N;i++){long long w;scanf("%lld",&w);W64[i]=w;W32[i]=(uint32_t)w;}

  tdzdd::Graph g;
  vector<pair<int,int>> EDGES(M);
  for(int i=0;i<M;i++){
    int u,v;scanf("%d %d",&u,&v);
    EDGES[i]={u,v};
    g.addEdge(to_string(u+1),to_string(v+1)); }
  g.update();

  int nv=g.vertexSize();
  fprintf(stderr,"DBG: N=%d M=%d K=%d nv=%d mateSize=%d\n",
          N,M,K,nv,g.maxFrontierSize());

  vector<uint32_t> weight_list(nv,0);
  for(int i=1;i<=nv;i++){
    int node_id=stoi(g.vertexName(i))-1;
    if(node_id>=0&&node_id<N) weight_list[i-1]=W32[node_id]; }
  fprintf(stderr,"DBG: weight_list[0]=%u [%d]=%u lower=%lld upper=%lld\n",
          weight_list[0],nv-1,weight_list[nv-1],L_bound,U_bound-1);

  // Single-pass combined spec
  fprintf(stderr,"DBG: building combined DD (k=%d, [%lld,%lld])...\n",
          K,L_bound,U_bound-1); fflush(stderr);

  CombinedPartitionSpec spec(g, weight_list,
                             (CombinedCount::count_t)K,
                             (CombinedCount::count_t)K,
                             (int32_t)L_bound, (int32_t)(U_bound-1));
  tdzdd::DdStructure<2> dd(spec);
  dd.zddReduce();
  fprintf(stderr,"DBG: DD size=%zu\n", dd.size()); fflush(stderr);

  long long zdd_nodes=(long long)dd.size();
  string cnt=dd.zddCardinality();
  long long n_sol=0;
  try{n_sol=stoll(cnt);}catch(...){n_sol=LLONG_MAX;}

  // Best ratio search
  double best_ratio=1e18;
  vector<long long> best_pops;
  long long sampled=0;
  bool is_approx=false;

  for(auto it=dd.begin();it!=dd.end();++it){
    if(sampled>=MAX_ITER){is_approx=true;break;}
    sampled++;
    vector<int> parent(N); iota(parent.begin(),parent.end(),0);
    function<int(int)> find=[&](int x)->int{
      while(parent[x]!=x){parent[x]=parent[parent[x]];x=parent[x];}return x;};
    for(int lv:*it){
      int ei=M-lv; if(ei<0||ei>=M)continue;
      int u=EDGES[ei].first,v=EDGES[ei].second;
      int pu=find(u),pv=find(v); if(pu!=pv)parent[pu]=pv; }
    unordered_map<int,long long> cw;
    for(int i=0;i<N;i++)cw[find(i)]+=W64[i];
    vector<long long> pops;
    for(auto& kv:cw)pops.push_back(kv.second);
    sort(pops.begin(),pops.end());
    if((int)pops.size()!=K)continue;
    double r=(double)pops.back()/(double)pops.front();
    if(r<best_ratio){best_ratio=r;best_pops=pops;} }

  printf("{\"n_solutions\": %lld, \"zdd_nodes\": %lld, \"best_ratio\": %.6f, "
         "\"is_approximate\": %s, \"best_pops\": [",
         n_sol,zdd_nodes,best_ratio,is_approx?"true":"false");
  for(int i=0;i<(int)best_pops.size();i++){if(i)printf(", ");printf("%lld",best_pops[i]);}
  printf("]}\n");
  return 0;
}
