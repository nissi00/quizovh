const statisticsExamCode=(new URLSearchParams(location.search).get('exam')||'').trim().toUpperCase();
let statisticsActiveQuestion='';
let statisticsSyncQueued=false;

function visibleExamQuestionId(){
  const input=document.querySelector('.exam-question-page input[name^="q-"]');
  if(!input)return'';
  return String(input.name||'').replace(/^q-/, '');
}

function sendExamTiming(action,questionId,keepalive=false){
  if(!statisticsExamCode||!questionId)return Promise.resolve();
  return fetch('/api/statistics/exam-timing',{
    method:'POST',credentials:'same-origin',keepalive,
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({exam_code:statisticsExamCode,question_id:questionId,action})
  }).catch(()=>undefined);
}

function syncExamTiming(){
  statisticsSyncQueued=false;
  const next=document.visibilityState==='visible'?visibleExamQuestionId():'';
  if(next===statisticsActiveQuestion)return;
  const previous=statisticsActiveQuestion;
  statisticsActiveQuestion=next;
  if(previous)void sendExamTiming('pause',previous);
  if(next)void sendExamTiming('enter',next);
}

function queueExamTimingSync(){
  if(statisticsSyncQueued)return;
  statisticsSyncQueued=true;
  requestAnimationFrame(syncExamTiming);
}

const examStatisticsObserver=new MutationObserver(queueExamTimingSync);
const examStatisticsRoot=document.querySelector('#examApp');
if(examStatisticsRoot)examStatisticsObserver.observe(examStatisticsRoot,{childList:true,subtree:true});

document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden'){
    const previous=statisticsActiveQuestion;
    statisticsActiveQuestion='';
    if(previous)void sendExamTiming('pause',previous,true);
  }else queueExamTimingSync();
});

window.addEventListener('pagehide',()=>{
  const previous=statisticsActiveQuestion;
  statisticsActiveQuestion='';
  if(previous)void sendExamTiming('pause',previous,true);
});

queueExamTimingSync();
