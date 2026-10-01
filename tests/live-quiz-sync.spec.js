import { test, expect } from '@playwright/test';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  host:process.env.PGHOST,
  port:Number(process.env.PGPORT || 5432),
  database:process.env.PGDATABASE,
  user:process.env.PGUSER,
  password:process.env.PGPASSWORD,
  max:5
});

const instructorId = '10000000-0000-0000-0000-000000000001';
const groupId = '10000000-0000-0000-0000-000000000002';
const secondQuestionId = '10000000-0000-0000-0000-000000000003';
let quizId;
let questionIds = [];

async function prepareBaseFixture() {
  const catalogue = await pool.query(
    `SELECT qz.id AS quiz_id,q.id AS question_id,c.theme_id
     FROM quizzes qz
     JOIN chapters c ON c.id=qz.chapter_id
     JOIN questions q ON q.quiz_id=qz.id
     WHERE qz.is_active AND c.is_active AND q.is_active AND q.archived_at IS NULL
     ORDER BY q.position,q.id LIMIT 1`
  );
  if (!catalogue.rows.length) throw new Error('Le catalogue de test doit contenir au moins une question.');
  quizId = catalogue.rows[0].quiz_id;
  questionIds = [catalogue.rows[0].question_id,secondQuestionId];
  await pool.query(
    `INSERT INTO questions(id,quiz_id,body,difficulty,subtopic,duration_seconds,position)
     VALUES($1,$2,'Question temporaire de synchronisation',1,'Test',30,999)
     ON CONFLICT(id) DO NOTHING`,
    [secondQuestionId,quizId]
  );
  await pool.query(
    `INSERT INTO answer_options(question_id,label,body,is_correct)
     SELECT $1,'A','Réponse correcte',true
     WHERE NOT EXISTS (SELECT 1 FROM answer_options WHERE question_id=$1)`,
    [secondQuestionId]
  );
  await pool.query(
    `INSERT INTO answer_options(question_id,label,body,is_correct)
     SELECT $1,'B','Réponse incorrecte',false
     WHERE NOT EXISTS (SELECT 1 FROM answer_options WHERE question_id=$1 AND label='B')`,
    [secondQuestionId]
  );
  await pool.query(
    `INSERT INTO app_users(id,email,first_name,last_name,role)
     VALUES($1,'tests@tech-systemes.invalid','Test','Instructeur','instructor')
     ON CONFLICT(id) DO NOTHING`,
    [instructorId]
  );
  await pool.query(
    `INSERT INTO training_groups(id,theme_id,instructor_id,name,start_date,end_date,status)
     VALUES($1,$2,$3,'Groupe tests synchronisation',current_date,current_date,'active')
     ON CONFLICT(id) DO NOTHING`,
    [groupId,catalogue.rows[0].theme_id,instructorId]
  );
}

async function createSession(code) {
  const result = await pool.query(
    `INSERT INTO live_sessions(code,quiz_id,group_id,instructor_id,show_podium,status)
     VALUES($1,$2,$3,$4,false,'waiting') RETURNING id`,
    [code,quizId,groupId,instructorId]
  );
  return result.rows[0].id;
}

async function joinLearners(browser, baseURL, code, count, scenario) {
  const learners = [];
  for (let index = 1; index <= count; index += 1) {
    const context = await browser.newContext({ baseURL });
    const response = await context.request.post('/api/learner/join', {
      data:{
        code,
        first_name:`${scenario}${index}`,
        last_name:'Virtuel',
        show_on_podium:false,
        data_processing_informed:true,
        privacy_policy_acknowledged:true
      }
    });
    expect(response.ok(),await response.text()).toBeTruthy();
    const page = await context.newPage();
    page.on('pageerror',error => console.log(`[navigateur ${scenario}${index}] ${error.message}`));
    page.on('console',message => {
      if (message.type() === 'error') console.log(`[console ${scenario}${index}] ${message.text()}`);
    });
    learners.push({ context,page });
  }
  return learners;
}

async function approveAll(sessionId) {
  await pool.query("UPDATE session_participants SET status='joined' WHERE session_id=$1",[sessionId]);
}

async function setQuestion(sessionId, questionId, durationSeconds = 30) {
  await pool.query(
    `UPDATE live_sessions SET status='live',current_question_id=$2,
       question_started_at=now(),question_ends_at=now()+($3 * interval '1 second')
     WHERE id=$1`,
    [sessionId,questionId,durationSeconds]
  );
}

async function openLearner(learner, code) {
  await learner.page.goto(`/learner.html?session=${code}`);
  await expect(learner.page.locator('#validate')).toBeVisible();
}

async function openPowerPoint(browser, baseURL, code, { disableEventSource = false } = {}) {
  const context = await browser.newContext({ baseURL });
  if (disableEventSource) {
    await context.addInitScript(() => { window.EventSource = undefined; });
  }
  await context.addInitScript(({ storageKey,sessionCode }) => {
    localStorage.setItem(storageKey,JSON.stringify({ assigned:true,sessionCode,examCode:'',displayMode:'session' }));
  },{ storageKey:'tsQuizPowerpointSlideContextV2',sessionCode:code });
  const page = await context.newPage();
  await page.route('https://appsforoffice.microsoft.com/**',route => route.fulfill({
    contentType:'application/javascript',
    body:'window.Office={onReady:()=>Promise.resolve(),context:{},AsyncResultStatus:{Succeeded:"succeeded"}};'
  }));
  await page.goto('/powerpoint.html');
  return { context,page };
}

async function chooseAndSubmit(page) {
  await page.locator('input[name=answer]').first().check();
  const responsePromise = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes('/api/learner/answers')
  ).catch(() => null);
  await page.locator('#validate').click();
  const response = await responsePromise;
  console.log(`[validation] ${response ? `${response.status()} ${response.url()}` : 'aucune réponse HTTP'}`);
  await expect(page.locator('#validate')).toHaveText(/Réponse (enregistrée|validée)/);
}

async function closeAll(entries) {
  await Promise.all(entries.map(entry => entry.context.close()));
}

test.beforeAll(prepareBaseFixture);
test.afterAll(async () => pool.end());

test('cinq réponses convergent vers 5/5 puis le sondage', async ({ browser,baseURL }) => {
  const code = 'SYNC5OK';
  const sessionId = await createSession(code);
  const learners = await joinLearners(browser,baseURL,code,5,'Synchro');
  await approveAll(sessionId);
  const powerpoint = await openPowerPoint(browser,baseURL,code);
  await setQuestion(sessionId,questionIds[0],30);
  await Promise.all(learners.map(learner => openLearner(learner,code)));

  for (let index = 0; index < learners.length; index += 1) {
    await chooseAndSubmit(learners[index].page);
    if (index < learners.length - 1) {
      await expect(powerpoint.page.locator('.response-footer > div').first()).toContainText(`${index + 1} / 5`);
    }
  }
  await expect(powerpoint.page.locator('.poll-stage')).toBeVisible();
  const state = await powerpoint.context.request.get(`/api/quality/presentation/state?code=${code}`);
  expect(await state.json()).toMatchObject({ status:'polling',joined_count:5,answered_count:5 });
  await closeAll([...learners,powerpoint]);
});

test('la fin du chrono fait converger apprenants et PowerPoint vers le sondage', async ({ browser,baseURL }) => {
  const code = 'TIMER5OK';
  const sessionId = await createSession(code);
  const learners = await joinLearners(browser,baseURL,code,5,'Minuteur');
  await approveAll(sessionId);
  const powerpoint = await openPowerPoint(browser,baseURL,code);
  await setQuestion(sessionId,questionIds[0],8);
  await Promise.all(learners.map(learner => openLearner(learner,code)));
  for (let index = 0; index < 3; index += 1) await chooseAndSubmit(learners[index].page);
  await expect(powerpoint.page.locator('.response-footer > div').first()).toContainText('3 / 5');

  const deadlineResult = await pool.query('SELECT question_ends_at FROM live_sessions WHERE id=$1',[sessionId]);
  const deadline = new Date(deadlineResult.rows[0].question_ends_at).getTime();
  const stateBeforeExpiry = await powerpoint.context.request.get(`/api/quality/presentation/state?code=${code}`);
  const statePayload = await stateBeforeExpiry.json();
  expect(new Date(statePayload.question_ends_at).getTime()).toBe(deadline);
  for (let sample = 0; sample < 5; sample += 1) {
    const clockState = await (await powerpoint.context.request.get(`/api/quality/presentation/state?code=${code}`)).json();
    const remainingMs = new Date(clockState.question_ends_at).getTime() - new Date(clockState.server_now).getTime();
    const remainder = ((remainingMs % 1000) + 1000) % 1000;
    const waitToMiddle = remainder >= 500 ? remainder - 500 : remainder + 500;
    await powerpoint.page.waitForTimeout(waitToMiddle);
    const timers = await Promise.all([
      powerpoint.page.locator('#questionTimer').textContent(),
      ...learners.map(learner => learner.page.locator('#timer').textContent())
    ]);
    expect(new Set(timers).size,`Chronos divergents : ${timers.join(' / ')}`).toBe(1);
    if (sample < 4) await powerpoint.page.waitForTimeout(700);
  }
  await expect(powerpoint.page.locator('.poll-stage')).toBeVisible({ timeout:10_000 });
  const transitionDelay = Date.now() - deadline;
  console.log(`[mesure] sondage PowerPoint affiché ${transitionDelay} ms après l’échéance serveur`);
  expect(transitionDelay).toBeLessThan(2_500);
  for (const learner of learners) await expect(learner.page.locator('.poll-card')).toBeVisible({ timeout:3_000 });
  await closeAll([...learners,powerpoint]);
});

test('les étapes sondage, correction, attente et question suivante restent alignées', async ({ browser,baseURL }) => {
  const code = 'STEPS5OK';
  const sessionId = await createSession(code);
  const learners = await joinLearners(browser,baseURL,code,2,'Etape');
  await approveAll(sessionId);
  const powerpoint = await openPowerPoint(browser,baseURL,code);
  await setQuestion(sessionId,questionIds[0],30);
  await Promise.all(learners.map(learner => openLearner(learner,code)));
  await Promise.all(learners.map(learner => chooseAndSubmit(learner.page)));
  await expect(powerpoint.page.locator('.poll-stage')).toBeVisible();

  await pool.query("UPDATE live_sessions SET status='waiting' WHERE id=$1",[sessionId]);
  await expect(powerpoint.page.locator('.correction-stage')).toBeVisible();
  for (const learner of learners) await expect(learner.page.locator('.review-answers')).toBeVisible();

  await pool.query(
    `UPDATE live_sessions SET current_question_id=$2,question_started_at=NULL,question_ends_at=NULL WHERE id=$1`,
    [sessionId,questionIds[1]]
  );
  await expect(powerpoint.page.locator('.ready-stage')).toBeVisible();
  await setQuestion(sessionId,questionIds[1],30);
  await expect(powerpoint.page.locator('.question-stage')).toBeVisible();
  for (const learner of learners) await expect(learner.page.locator('#validate')).toBeVisible();
  await closeAll([...learners,powerpoint]);
});

test('le mode PowerPoint de secours converge en moins de deux secondes', async ({ browser,baseURL }) => {
  const code = 'FALLBACK';
  const sessionId = await createSession(code);
  const powerpoint = await openPowerPoint(browser,baseURL,code,{ disableEventSource:true });
  await expect(powerpoint.page.locator('.waiting-stage')).toBeVisible();

  const startedAt = Date.now();
  await setQuestion(sessionId,questionIds[0],30);
  await expect(powerpoint.page.locator('.question-stage')).toBeVisible({ timeout:3_000 });
  const transitionDelay = Date.now() - startedAt;
  console.log(`[mesure] transition PowerPoint sans SSE : ${transitionDelay} ms`);
  expect(transitionDelay).toBeLessThan(2_000);
  await closeAll([powerpoint]);
});

test('une microcoupure à la validation est retentée sans perdre la réponse', async ({ browser,baseURL }) => {
  const code = 'RETRY001';
  const sessionId = await createSession(code);
  const [learner] = await joinLearners(browser,baseURL,code,1,'Reseau');
  await approveAll(sessionId);
  await setQuestion(sessionId,questionIds[0],30);
  await openLearner(learner,code);

  let firstSubmission = true;
  await learner.page.route('**/api/learner/answers',async route => {
    if (route.request().method() === 'POST' && firstSubmission) {
      firstSubmission = false;
      return route.abort('failed');
    }
    return route.continue();
  });
  await learner.page.locator('input[name=answer]').first().check();
  await learner.page.locator('#validate').click();
  await expect(learner.page.locator('.poll-card')).toBeVisible();
  const submitted = await pool.query(
    'SELECT count(*)::integer AS count FROM live_answer_submissions WHERE session_id=$1',
    [sessionId]
  );
  expect(submitted.rows[0].count).toBe(1);
  await closeAll([learner]);
});

test('une coupure persistante ne prétend jamais que la réponse est enregistrée', async ({ browser,baseURL }) => {
  const code = 'RETRY002';
  const sessionId = await createSession(code);
  const [learner] = await joinLearners(browser,baseURL,code,1,'Coupure');
  await approveAll(sessionId);
  await setQuestion(sessionId,questionIds[0],30);
  await openLearner(learner,code);

  await learner.page.route('**/api/learner/answers',route => route.abort('failed'));
  await learner.page.locator('input[name=answer]').first().check();
  await learner.page.locator('#validate').click();
  await expect(learner.page.locator('#feedback')).toContainText('Réponse non enregistrée');
  await expect(learner.page.locator('#validate')).toBeEnabled();
  await expect(learner.page.locator('#validate')).toHaveText('Réessayer');
  await closeAll([learner]);
});
