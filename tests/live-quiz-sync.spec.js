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
let quizId;
let questionIds = [];

async function prepareBaseFixture() {
  const catalogue = await pool.query(
    `SELECT qz.id AS quiz_id,q.id AS question_id,c.theme_id
     FROM quizzes qz
     JOIN chapters c ON c.id=qz.chapter_id
     JOIN questions q ON q.quiz_id=qz.id
     WHERE qz.is_active AND c.is_active AND q.is_active AND q.archived_at IS NULL
       AND qz.id=(
         SELECT candidate.quiz_id FROM questions candidate
         WHERE candidate.is_active AND candidate.archived_at IS NULL
         GROUP BY candidate.quiz_id HAVING count(*)>=2
         ORDER BY candidate.quiz_id LIMIT 1
       )
     ORDER BY q.position,q.id LIMIT 2`
  );
  if (catalogue.rows.length < 2) throw new Error('Le catalogue de test doit contenir au moins deux questions.');
  quizId = catalogue.rows[0].quiz_id;
  questionIds = catalogue.rows.filter(row => row.quiz_id === quizId).map(row => row.question_id);
  if (questionIds.length < 2) throw new Error('Le quiz de test doit contenir au moins deux questions.');
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
    learners.push({ context,page:await context.newPage() });
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

async function openPowerPoint(browser, baseURL, code) {
  const context = await browser.newContext({ baseURL });
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
  await page.locator('#validate').click();
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
  await setQuestion(sessionId,questionIds[0],5);
  await Promise.all(learners.map(learner => openLearner(learner,code)));
  for (let index = 0; index < 3; index += 1) await chooseAndSubmit(learners[index].page);
  await expect(powerpoint.page.locator('.response-footer > div').first()).toContainText('3 / 5');

  const startedAt = Date.now();
  await expect(powerpoint.page.locator('.poll-stage')).toBeVisible({ timeout:10_000 });
  const elapsed = Date.now() - startedAt;
  console.log(`[mesure] sondage affiché ${elapsed} ms après le contrôle 3/5`);
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

test('un échec réseau ne doit jamais être présenté comme une réponse enregistrée', async ({ browser,baseURL }) => {
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
  await expect(learner.page.locator('#feedback')).toContainText('Réponse non enregistrée');
  await expect(learner.page.locator('#validate')).toBeEnabled();
  await expect(learner.page.locator('#validate')).toHaveText('Réessayer');
  await closeAll([learner]);
});
