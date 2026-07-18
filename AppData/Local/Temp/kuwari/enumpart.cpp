/**
 * enumpart.cpp  -  connected balanced k-partition enumerator
 * Ports Graphillion's GraphPartitionSpec + ComponentWeightSpec to native TdZdd.
 * Only change from Graphillion source: include paths.
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

// ====== GraphPartitionSpec (from Graphillion; only includes changed) =========

struct GraphPartitionSpecCount {
  using count_t = int16_t;
  count_t comp_lb, comp_ub;
  GraphPartitionSpecCount(): comp_lb(1), comp_ub(std::numeric_limits<count_t>::max()) {}
  GraphPartitionSpecCount(count_t lb, count_t ub): comp_lb(lb), comp_ub(ub) {}
  size_t hash() const { return (size_t(comp_lb)<<16)|(uint16_t)comp_ub; }
  bool operator==(GraphPartitionSpecCount const& o) const {
    return comp_lb==o.comp_lb && comp_ub==o.comp_ub; }
};

static int16_t const UNCOLORED                = 32766;
static int16_t const UNCOLORED_EDGE_COMPONENT = 32767;

union GraphPartitionSpecMate {
 public:
  typedef int16_t  Offset;
  typedef uint16_t uOffset;
 private:
  struct { Offset hoc; Offset nxt; };
  uint32_t fps_bits;
 public:
  GraphPartitionSpecMate(Offset hoc=0): hoc(hoc), nxt(0) {}
  bool operator==(GraphPartitionSpecMate const& o) const { return this==&o; }
  bool operator!=(GraphPartitionSpecMate const& o) const { return this!=&o; }
  void clear() { hoc=0; nxt=0; }
  bool isHead()     const { return hoc>=0; }
  bool isTail()     const { return nxt==0; }
  bool isIsolated() const { return isHead()&&isTail(); }
  GraphPartitionSpecMate&       head()       { return isHead()?*this:*(this+hoc); }
  GraphPartitionSpecMate const& head() const { return isHead()?*this:*(this+hoc); }
  GraphPartitionSpecMate&       next()       { return *(this+nxt); }
  GraphPartitionSpecMate const& next() const { return *(this+nxt); }
  bool isColored()               const { return head().hoc<UNCOLORED; }
  bool isUncoloredEdgeComponent()const { return head().hoc==UNCOLORED_EDGE_COMPONENT; }
  bool isColoredTail()           const { return hoc==0||(hoc<0&&hoc+(this+hoc)->hoc==0); }
  bool hasSameColorAs(GraphPartitionSpecMate const& o) const {
    GraphPartitionSpecMate const* p=&head(); GraphPartitionSpecMate const* q=&o.head();
    return p+p->hoc==q+q->hoc; }
  GraphPartitionSpecMate const* findColorPredecessor(GraphPartitionSpecMate const& o) const {
    assert(o.isColoredTail());
    GraphPartitionSpecMate const* p=&o;
    while(--p>=this){GraphPartitionSpecMate const* p1=&p->head();if(p1+p1->hoc==&o)return p;}
    return 0; }
  void mergeLists(GraphPartitionSpecMate& o1, GraphPartitionSpecMate& o2, bool countUEC) {
    GraphPartitionSpecMate* p1=&o1.head(), *p2=&o2.head();
    if(p1==p2)return; if(p1>p2)std::swap(p1,p2);
    bool painting;
    if(p2->hoc<UNCOLORED){
      painting=(p1->hoc>=UNCOLORED);
      if(painting||p1+p1->hoc<p2+p2->hoc) p1->hoc=p2->hoc+(p2-p1);
    } else {
      painting=(p1->hoc<UNCOLORED);
      if(countUEC&&p1->hoc==UNCOLORED) p1->hoc=UNCOLORED_EDGE_COMPONENT;
    }
    for(GraphPartitionSpecMate* q=p2;;q+=q->nxt){q->hoc=p1-q;if(q->nxt==0)break;}
    GraphPartitionSpecMate* p=p1, *q=p2;
    while(true){
      assert(p!=q);
      GraphPartitionSpecMate* pp=p+p->nxt; assert(p<=pp&&pp!=q);
      while(p<pp&&pp<q){p=pp;pp+=pp->nxt;assert(p<=pp&&pp!=q);}
      assert(p==pp||q<pp); p->nxt=q-p; if(p==pp)break; p=q;q=pp; }
    if(painting){
      while(q->nxt)q+=q->nxt;
      GraphPartitionSpecMate* pp=p1+p1->hoc;
      if(pp<q){for(p=this;p<=pp;++p)if(p+p->hoc==pp)p->hoc=q-p;} } }
  void replaceHeadWith(GraphPartitionSpecMate& newHead) const {
    GraphPartitionSpecMate const* p=&head(); GraphPartitionSpecMate* q=&newHead;
    q->hoc=(p->hoc<UNCOLORED)?p->hoc+(p-q):p->hoc;
    while(q->nxt>0){q+=q->nxt;q->hoc=&newHead-q;} }
  void removeFromList(GraphPartitionSpecMate const& o) {
    if(o.isColoredTail()){
      assert(o.nxt==0);
      GraphPartitionSpecMate const* pp=findColorPredecessor(o); if(pp==0)return;
      for(GraphPartitionSpecMate* p=this;p<=pp;++p){
        if(p+p->hoc==&o)p->hoc=pp-p; if(p+p->nxt==&o)p->nxt=0; }
    } else if(o.nxt==0){
      for(GraphPartitionSpecMate* p=this;p<=&o;++p)if(p+p->nxt==&o)p->nxt=0;
    } else {
      for(GraphPartitionSpecMate* p=this;p<=&o;++p)if(p+p->nxt==&o)p->nxt+=o.nxt; }
  }
  friend class GraphPartitionSpec;
};

class GraphPartitionSpec
    : public tdzdd::HybridDdSpec<GraphPartitionSpec,GraphPartitionSpecCount,GraphPartitionSpecMate,2> {
  typedef GraphPartitionSpecCount Count;
  typedef GraphPartitionSpecMate  Mate;
  tdzdd::Graph const& graph;
  int const m,n,mateSize,fpsCellSize,fpsSize;
  std::vector<Mate> initialMate;
  Count::count_t comp_lb,comp_ub;
  bool const noLoop,lookahead,countUEC;

  void setF(Mate::Offset v1,Mate::Offset v2,Mate* mate,int val) const {
    if(v1>v2)std::swap(v1,v2);
    int p=-v1*(v1+3)/2+v1*mateSize-1+v2;
    if(val)mate[mateSize+p/fpsCellSize].fps_bits|=(1u<<(p%fpsCellSize));
    else   mate[mateSize+p/fpsCellSize].fps_bits&=~(1u<<(p%fpsCellSize)); }
  int getF(Mate::Offset v1,Mate::Offset v2,Mate const* mate) const {
    if(v1>v2)std::swap(v1,v2);
    int p=-v1*(v1+3)/2+v1*mateSize-1+v2;
    return(mate[mateSize+p/fpsCellSize].fps_bits>>(p%fpsCellSize))&1u; }
  void addToFPS(Mate::Offset v1,Mate::Offset v2,Mate* mate) const {setF(v1,v2,mate,1);}
  void changeRepFPS(Mate::Offset v1,Mate::Offset v2,Mate* mate) const {
    for(int i=0;i<mateSize;++i){if(i==v1||i==v2)continue;assert(getF(v2,i,mate)==0);setF(v2,i,mate,getF(v1,i,mate));} }
  void mergeFPS(Mate::Offset v1,Mate::Offset v2,Mate* mate) const {
    if(v1>v2)std::swap(v1,v2);
    for(int i=0;i<mateSize;++i){if(i==v1||i==v2)continue;if(getF(v2,i,mate))setF(v1,i,mate,1);setF(v2,i,mate,0);} }
  void shiftFPS(Mate::Offset d,Mate* mate) const {
    for(int i=0;i<mateSize-1;++i){int j;
      for(j=i+1;j<mateSize-d;++j)setF(i,j,mate,getF(i+d,j+d,mate));
      for(;j<mateSize;++j)setF(i,j,mate,0);} }
  bool isInFPS(Mate::Offset v1,Mate::Offset v2,Mate const* mate) const {return getF(v1,v2,mate)!=0;}

  int takable(Count& c,Mate const* mate,tdzdd::Graph::EdgeInfo const& e) const {
    Mate const& w1=mate[e.v1-e.v0]; Mate const& w2=mate[e.v2-e.v0];
    if(noLoop&&w1.head()==w2.head())return false;
    if(w1.isColored()&&w2.isColored()&&!w1.hasSameColorAs(w2))return false;
    if(w1.head()!=w2.head()&&isInFPS(&w1.head()-mate,&w2.head()-mate,mate))return false;
    if(e.v1final&&e.v2final){
      if(w1.isIsolated()&&w2.isIsolated()){
        if(w2.isColored()){if(!w2.isColoredTail())return false;if(mate[1].findColorPredecessor(w2))return false;}
        else{if(w1.isColored()){if(!w1.isColoredTail())return false;}
             else{if(c.comp_ub==0)return false;if(c.comp_ub>0){c.comp_lb--;c.comp_ub--;}}}
      } else if(w1.isHead()&&w2==w1.next()&&w2.isTail()){
        if(w1.isColored()){if(!w2.isColoredTail())return false;if(w2.findColorPredecessor(mate[1]))return false;}
        else{assert(!countUEC||w1.isUncoloredEdgeComponent());
             if(c.comp_ub==0)return false;if(c.comp_ub>0){c.comp_lb--;c.comp_ub--;}}
      }
    }
    if(e.finalEdge&&c.comp_lb>0)return false;
    return true; }

  bool doTake(Count& count,Mate* mate,tdzdd::Graph::EdgeInfo const& e) const {
    Count c=count; if(!takable(c,mate,e))return false; count=c;
    Mate const& w1=mate[e.v1-e.v0]; Mate const& w2=mate[e.v2-e.v0];
    if(w1.head()!=w2.head())mergeFPS(&w1.head()-mate,&w2.head()-mate,mate);
    mate[0].mergeLists(mate[e.v1-e.v0],mate[e.v2-e.v0],countUEC);
    return true; }

  bool doNotTake(Count& count,Mate* mate,tdzdd::Graph::EdgeInfo const& e) const {
    Count c=count;
    Mate const& w1=mate[e.v1-e.v0]; Mate const& w2=mate[e.v2-e.v0];
    if(w1.head()==w2.head())return false;
    addToFPS(&w1.head()-mate,&w2.head()-mate,mate);
    if(e.v1final&&w1.isIsolated()){
      if(w1.isColored()){if(!w1.isColoredTail())return false;}
      else if(c.comp_ub>=0){if(!countUEC||w1.isUncoloredEdgeComponent()){if(c.comp_ub==0)return false;c.comp_lb--;c.comp_ub--;}}
    }
    if(e.v2final&&w2.isIsolated()){
      if(w2.isColored()){if(!w2.isColoredTail())return false;if(mate[1].findColorPredecessor(w2))return false;}
      else if(c.comp_ub>=0){if(!countUEC||w2.isUncoloredEdgeComponent()){if(c.comp_ub==0)return false;c.comp_lb--;c.comp_ub--;}}
    }
    if(e.v1final&&e.v2final&&w1.isHead()&&w2==w1.next()&&w2.isTail()){
      if(w1.isColored()){if(!w2.isColoredTail())return false;if(w2.findColorPredecessor(mate[1]))return false;}
      else{assert(!countUEC||w1.isUncoloredEdgeComponent());if(c.comp_ub==0)return false;if(c.comp_ub>0){c.comp_lb--;c.comp_ub--;}}
    }
    if(e.finalEdge&&c.comp_lb>0)return false;
    count=c; return true; }

  void update(Mate* mate,tdzdd::Graph::EdgeInfo const& e,tdzdd::Graph::EdgeInfo const& ee) const {
    int const d=ee.v0-e.v0; assert(d>=0);
    Mate* p1=&mate[e.v1-e.v0], *p2=&mate[e.v2-e.v0], *pd=p1+d;
    for(Mate* q=p1;q<pd;++q){Mate* qq=&q->next();if(qq>=pd){changeRepFPS(&q->head()-mate,qq-mate,mate);q->replaceHeadWith(*qq);}}
    if(d>0)shiftFPS(d,mate);
    if(e.v2final){mate[0].removeFromList(*p2);p2->clear();}
    if(e.v1final){mate[0].removeFromList(*p1);p1->clear();}
    if(d>0){
      std::memmove(p1,pd,(mateSize-d)*sizeof(*mate));
      for(int i=mateSize-d;i<mateSize;++i)p1[i]=initialMate[ee.v0+i]; } }

 public:
  GraphPartitionSpec(tdzdd::Graph const& graph,
                     Count::count_t lb=1,
                     Count::count_t ub=std::numeric_limits<Count::count_t>::max(),
                     bool noLoop=false,bool lookahead=true,bool countUEC=true)
      : graph(graph),m(graph.vertexSize()),n(graph.edgeSize()),
        mateSize(graph.maxFrontierSize()),
        fpsCellSize(2*sizeof(Mate::Offset)*8),
        fpsSize(((mateSize-1)*mateSize/2-1)/fpsCellSize+1),
        initialMate(1+m+mateSize),
        comp_lb(lb),comp_ub(ub),noLoop(noLoop),lookahead(lookahead),countUEC(countUEC)
  {
    this->setArraySize(mateSize+fpsSize);
    std::vector<int> rootOfColor(graph.numColor()+1);
    for(int v=1;v<=m;++v)rootOfColor[graph.colorNumber(v)]=v;
    for(int v=1;v<=m;++v){
      int k=graph.colorNumber(v);
      int hoc=(k>0)?rootOfColor[k]-v:UNCOLORED;
      initialMate[v]=Mate(hoc); }
  }
  int getRoot(Count& count,Mate* mate) const {
    int const v0=graph.edgeInfo(0).v0;
    count=Count{comp_lb,comp_ub};
    for(int i=0;i<mateSize;++i)mate[i]=initialMate[v0+i];
    for(int i=0;i<fpsSize;++i)mate[mateSize+i].fps_bits=0;
    return n; }
  int getChild(Count& count,Mate* mate,int level,int take) const {
    assert(1<=level&&level<=n);
    int i=n-level;
    tdzdd::Graph::EdgeInfo const* e=&graph.edgeInfo(i);
    if(take){if(!doTake(count,mate,*e))return 0;}
    else    {if(!doNotTake(count,mate,*e))return 0;}
    if(++i==n)return -1;
    tdzdd::Graph::EdgeInfo const* ee=&graph.edgeInfo(i);
    update(mate,*e,*ee);
    while(lookahead){
      e=ee; Count c=count; if(takable(c,mate,*e))break;
      if(!doNotTake(count,mate,*e))return 0;
      if(++i==n)return -1;
      ee=&graph.edgeInfo(i); update(mate,*e,*ee); }
    assert(i<n); return n-i; }
  size_t hashCode(Count const& count) const { return count.hash(); }
};

// ====== ComponentWeightSpec (from Graphillion; only includes changed) =======

class ComponentWeightSpecMate {
 public:
  typedef int32_t  Offset;
  typedef uint32_t uOffset;
 private:
  Offset hoc; Offset nxt;
 public:
  ComponentWeightSpecMate(Offset hoc=0): hoc(hoc),nxt(0){}
  bool operator==(ComponentWeightSpecMate const& o) const {return this==&o;}
  bool operator!=(ComponentWeightSpecMate const& o) const {return this!=&o;}
  void clear(){hoc=0;nxt=0;}
  bool isHead()     const {return hoc>=0;}
  bool isTail()     const {return nxt==0;}
  bool isIsolated() const {return isHead()&&isTail();}
  ComponentWeightSpecMate&       head()       {return isHead()?*this:*(this+hoc);}
  ComponentWeightSpecMate const& head() const {return isHead()?*this:*(this+hoc);}
  ComponentWeightSpecMate&       next()       {return *(this+nxt);}
  ComponentWeightSpecMate const& next() const {return *(this+nxt);}
  int getWeight() const {assert(head().hoc>=0);return head().hoc;}
  void mergeLists(ComponentWeightSpecMate& o1,ComponentWeightSpecMate& o2,ComponentWeightSpecMate* /*mate*/) {
    ComponentWeightSpecMate* p1=&o1.head(), *p2=&o2.head();
    if(p1==p2)return; if(p1>p2)std::swap(p1,p2);
    p1->hoc+=p2->hoc;
    for(ComponentWeightSpecMate* q=p2;;q+=q->nxt){q->hoc=p1-q;if(q->nxt==0)break;}
    ComponentWeightSpecMate* p=p1, *q=p2;
    while(true){
      assert(p!=q);
      ComponentWeightSpecMate* pp=p+p->nxt; assert(p<=pp&&pp!=q);
      while(p<pp&&pp<q){p=pp;pp+=pp->nxt;assert(p<=pp&&pp!=q);}
      assert(p==pp||q<pp); p->nxt=q-p; if(p==pp)break; p=q;q=pp; } }
  void replaceHeadWith(ComponentWeightSpecMate& newHead,ComponentWeightSpecMate* /*mate*/) const {
    ComponentWeightSpecMate const* p=&head(); ComponentWeightSpecMate* q=&newHead;
    q->hoc=p->hoc;
    while(q->nxt>0){q+=q->nxt;q->hoc=&newHead-q;} }
  void removeFromList(ComponentWeightSpecMate const& o) {
    if(o.nxt==0){for(ComponentWeightSpecMate* p=this;p<=&o;++p)if(p+p->nxt==&o)p->nxt=0;}
    else        {for(ComponentWeightSpecMate* p=this;p<=&o;++p)if(p+p->nxt==&o)p->nxt+=o.nxt;} }
};

class ComponentWeightSpec
    : public tdzdd::PodArrayDdSpec<ComponentWeightSpec,ComponentWeightSpecMate,2> {
  typedef ComponentWeightSpecMate Mate;
  tdzdd::Graph const& graph;
  int const m,n,lower,upper,mateSize;
  std::vector<Mate> initialMate;
  bool const lookahead;

  int takable(Mate const* mate,tdzdd::Graph::EdgeInfo const& e) const {
    Mate const& w1=mate[e.v1-e.v0]; Mate const& w2=mate[e.v2-e.v0];
    if(w1.head()!=w2.head()&&w1.getWeight()+w2.getWeight()>upper)return false;
    if(e.v1final&&e.v2final){
      if(w1.isIsolated()&&w2.isIsolated()){if(w1.getWeight()+w2.getWeight()<lower)return false;}
      else if(w1.isHead()&&w2==w1.next()&&w2.isTail()){if(w1.getWeight()<lower)return false;}
    }
    return true; }
  bool doTake(Mate* mate,tdzdd::Graph::EdgeInfo const& e) const {
    if(!takable(mate,e))return false;
    mate[0].mergeLists(mate[e.v1-e.v0],mate[e.v2-e.v0],mate);
    assert(mate[0].getWeight()<=upper); return true; }
  bool doNotTake(Mate* mate,tdzdd::Graph::EdgeInfo const& e) const {
    Mate& w1=mate[e.v1-e.v0]; Mate& w2=mate[e.v2-e.v0];
    if(e.v1final&&w1.isIsolated()&&w1.getWeight()<lower)return false;
    if(e.v2final&&w2.isIsolated()&&w2.getWeight()<lower)return false;
    if(e.v1final&&e.v2final&&w1.isHead()&&w2==w1.next()&&w2.isTail()&&w1.getWeight()<lower)return false;
    return true; }
  void update(Mate* mate,tdzdd::Graph::EdgeInfo const& e,tdzdd::Graph::EdgeInfo const& ee) const {
    int const d=ee.v0-e.v0; assert(d>=0);
    Mate* p1=&mate[e.v1-e.v0], *p2=&mate[e.v2-e.v0], *pd=p1+d;
    for(Mate* q=p1;q<pd;++q){Mate* qq=&q->next();if(qq>=pd)q->replaceHeadWith(*qq,mate);}
    if(e.v2final){mate[0].removeFromList(*p2);p2->clear();}
    if(e.v1final){mate[0].removeFromList(*p1);p1->clear();}
    if(d>0){
      std::memmove(p1,pd,(mateSize-d)*sizeof(*mate));
      for(int i=mateSize-d;i<mateSize;++i)p1[i]=initialMate[ee.v0+i]; } }
 public:
  ComponentWeightSpec(tdzdd::Graph const& graph,
                      const std::vector<uint32_t>& weight_list,
                      uint32_t lower,uint32_t upper,
                      bool /*noLoop*/=false,bool lookahead=true)
      : graph(graph),m(graph.vertexSize()),n(graph.edgeSize()),
        lower(lower),upper(upper),
        mateSize(graph.maxFrontierSize()),
        initialMate(1+m+mateSize),
        lookahead(lookahead)
  {
    this->setArraySize(mateSize);
    for(int u=0;u<m;++u)initialMate[u+1]=Mate(Mate::Offset(weight_list[u]));
  }
  int getRoot(Mate* mate) const {
    for(int v=1;v<=m;++v)if(initialMate[v].getWeight()>upper)return 0;
    int const v0=graph.edgeInfo(0).v0;
    for(int i=0;i<mateSize;++i)mate[i]=initialMate[v0+i];
    return n; }
  int getChild(Mate* mate,int level,int take) const {
    assert(1<=level&&level<=n);
    int i=n-level;
    tdzdd::Graph::EdgeInfo const* e=&graph.edgeInfo(i);
    if(take){if(!doTake(mate,*e))return 0;}
    else    {if(!doNotTake(mate,*e))return 0;}
    if(++i==n)return -1;
    tdzdd::Graph::EdgeInfo const* ee=&graph.edgeInfo(i);
    update(mate,*e,*ee);
    while(lookahead){
      e=ee; if(takable(mate,*e))break;
      if(!doNotTake(mate,*e))return 0;
      if(++i==n)return -1;
      ee=&graph.edgeInfo(i); update(mate,*e,*ee); }
    assert(i<n); return n-i; }
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
  fprintf(stderr,"DBG: N=%d M=%d K=%d nv=%d\n",N,M,K,nv);

  // weight_list[i] = weight of tdzdd vertex (i+1)
  // label "j" -> node_id = j-1
  vector<uint32_t> weight_list(nv,0);
  for(int i=1;i<=nv;i++){
    int node_id=stoi(g.vertexName(i))-1;
    if(node_id>=0&&node_id<N)weight_list[i-1]=W32[node_id]; }
  fprintf(stderr,"DBG: weight_list[0]=%u [%d]=%u\n",weight_list[0],nv-1,weight_list[nv-1]);

  // Step 1: k-partition DD
  fprintf(stderr,"DBG: building partition DD...\n");fflush(stderr);
  GraphPartitionSpec gpspec(g,(int16_t)K,(int16_t)K,false,true,false);
  tdzdd::DdStructure<2> dd(gpspec);
  dd.zddReduce();
  fprintf(stderr,"DBG: partition DD size=%zu\n",dd.size());

  // Step 2: weight filter [L,U-1]
  fprintf(stderr,"DBG: weight constraint [%lld,%lld]...\n",L_bound,U_bound-1);fflush(stderr);
  ComponentWeightSpec cwspec(g,weight_list,(uint32_t)L_bound,(uint32_t)(U_bound-1));
  dd.zddSubset(cwspec);
  dd.zddReduce();
  fprintf(stderr,"DBG: weight-filtered DD size=%zu\n",dd.size());

  long long zdd_nodes=(long long)dd.size();
  string cnt=dd.zddCardinality();
  long long n_sol=0;
  try{n_sol=stoll(cnt);}catch(...){n_sol=LLONG_MAX;}

  // Step 3: best ratio
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
