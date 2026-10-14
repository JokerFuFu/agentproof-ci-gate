// Orders local read snapshots around mutations. This is client UX protection;
// the server still decides policy validity, replay, expiry and human authority.
export class RequestSession {
  requests=[];selectedId=null;online=false;
  #epoch=0;#latestLoad=0;#operation=null;#selectionVersion=0;#operationSerial=0;
  get current(){return this.requests.find(r=>r.id===this.selectedId)??null;}
  get busy(){return this.#operation!==null;}
  get operation(){return this.#operation;}
  beginLoad(){return {epoch:this.#epoch,sequence:++this.#latestLoad};}
  #currentLoad(ticket){return ticket.epoch===this.#epoch&&ticket.sequence===this.#latestLoad&&!this.busy;}
  applyLoad(ticket,requests){
    if(!this.#currentLoad(ticket))return false;
    this.requests=requests;this.online=true;
    if(!this.requests.some(r=>r.id===this.selectedId))this.selectedId=this.requests[0]?.id??null;
    return true;
  }
  failLoad(ticket){if(!this.#currentLoad(ticket))return false;this.online=false;return true;}
  select(id){if(!this.requests.some(r=>r.id===id))return false;this.selectedId=id;this.#selectionVersion++;return true;}
  beginOperation(action,requestId){
    if(this.busy)return null;
    this.#epoch++;this.#operation={id:++this.#operationSerial,action,requestId,selectionVersion:this.#selectionVersion};
    return this.#operation;
  }
  applyOperation(ticket,request,{select=false}={}){
    if(this.#operation!==ticket||!request?.id)return false;
    const i=this.requests.findIndex(r=>r.id===request.id);
    if(i<0)this.requests.unshift(request);else this.requests[i]=request;
    this.online=true;
    if(select&&ticket.selectionVersion===this.#selectionVersion)this.selectedId=request.id;
    return true;
  }
  endOperation(ticket){if(this.#operation!==ticket)return false;this.#operation=null;this.#epoch++;return true;}
}
