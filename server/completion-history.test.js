import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../completion-attestations.js',import.meta.url),'utf8');
function context(fetch) {
  const box = {innerHTML:''};
  const ctx = vm.createContext({
    document:{querySelector:selector => selector === '#completionHistory' ? box : null},
    MutationObserver:class {observe() {}},URLSearchParams,fetch,
    alert:message => {throw new Error(message);},setTimeout,clearTimeout
  });
  vm.runInContext(source,ctx);
  return {ctx,box};
}

test('number search covers all history and clearing it restores the selected group filter', () => {
  const {ctx} = context();
  vm.runInContext("completionState.groupData={group:{id:'group-a'}}; completionState.historyNumber=' TS-AFF-2026-ABC1 ';",ctx);
  let params = new URLSearchParams(vm.runInContext('completionHistoryPath(1)',ctx).split('?')[1]);
  assert.equal(params.get('number'),'TS-AFF-2026-ABC1');
  assert.equal(params.has('group_id'),false);
  vm.runInContext("completionState.historyNumber='';",ctx);
  params = new URLSearchParams(vm.runInContext('completionHistoryPath(1)',ctx).split('?')[1]);
  assert.equal(params.get('group_id'),'group-a');
  assert.equal(params.has('number'),false);
});

test('a delayed old search cannot replace the latest cards or the document form defaults', async () => {
  const pending = [];
  const {ctx,box} = context(() => new Promise(resolve => pending.push(resolve)));
  vm.runInContext("completionState.historyNumber='OLD'; completionState.latestForm={keep:true}; completionState.groupForm={keep:true};",ctx);
  const old = vm.runInContext('refreshCompletionHistory(1)',ctx);
  vm.runInContext("completionState.historyNumber='NEW';",ctx);
  const latest = vm.runInContext('refreshCompletionHistory(1)',ctx);
  const payload = title => ({items:[{id:title,created_at:'2026-10-12',participant_count:1,form_snapshot:{training_title:title},participants:[]}],total:1,page:1,page_size:10});
  pending[1]({ok:true,text:async () => JSON.stringify(payload('NEW'))});
  await latest;
  pending[0]({ok:true,text:async () => JSON.stringify(payload('OLD'))});
  await old;
  assert.match(box.innerHTML,/>NEW</);
  assert.doesNotMatch(box.innerHTML,/>OLD</);
  assert.equal(vm.runInContext('completionState.latestForm.keep && completionState.groupForm.keep',ctx),true);
});
