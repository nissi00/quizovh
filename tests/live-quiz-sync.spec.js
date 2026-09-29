import { test, expect } from '@playwright/test';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  host:process.env.PGHOST,
  port:Number(process.env.PGPORT || 5432),
  database:process.env.PGDATABASE,
  user:process.env.PGUSER,
  password:process.env.PGPASSWORD,
  max:4
});

const instructorId = '10000000-0000-0000-0000-000000000001';
const groupId = '10000000-0000-0000-0000-000000000002';
const themeId = '00000000-0000-0000-0000-000000000001';
const quizId = '00000000-0000-0000-0000-000000000021';
const questionId = '00000000-0000-0000-0000-000000000031';

async function prepareBaseFixture() {
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
    [groupId,themeId,instructorId]
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

async function joinLearners(browser, baseURL, code, count) {
  const learners = [];
  for (let index = 1; index <= count; index += 1) {
    const context = await browser.newContext({ baseURL });
    const response = await context.request.post('/api/learner/join', {
      data:{
        code,
        first_name:`Participant${index}`,
        last_name:'Virtuel',
        show_on_podium:false,
        data_processing_informed:true,
        privacy_policy_acknowledged:true
      }
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    learners.push({ context, page:await context.newPage() });
  }
  return learners;
}

async function approveAll(sessionId) {
  await pool.query("UPDATE session_participants SET status='joined' WHERE session_id=$1", [sessionId]);
}

async function startQuestion(sessionId, durationSeconds = 30) {
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
  await context.addInitScript(({ storageKey, sessionCode }) => {
    localStorage.setItem(storageKey, JSON.stringify({
      assigned:true,
      sessionCode,
      examCode:'',
      displayMode:'session'
    }));
  }, { storageKey:'tsQuizPowerpointSlideContextV2', sessionCode:code });
  const page = await context.newPage();
  await page.route('https://appsforoffice.microsoft.com/**', route => route.fulfill({
    contentType:'application/javascript',
    body:'window.Office={onReady:()=>Promise.resolve(),context:{},AsyncResultStatus:{Succeeded:"succeeded"}};'
  }));
  await page.goto('/powerpoint.html');
  return { context, page };
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

test('quatre réponses font progresser le compteur puis affichent automatiquement le sondage', async ({ browser, baseURL }) => {
  const code = 'SYNC4OK';
  const sessionId = await createSession(code);
  const learners = await joinLearners(browser, baseURL, code, 4);
  await approveAll(sessionId);
  const powerpoint = await openPowerPoint(browser, baseURL, code);
  await expect(powerpoint.page.locator('#joinedCount')).toHaveText('4');

  await startQuestion(sessionId, 30);
  await expect(powerpoint.page.locator('.question-stage')).toBeVisible();
  await expect(powerpoint.page.locator('.response-footer > div').first()).toContainText('0 / 4');
  await Promise.all(learners.map(learner => openLearner(learner, code)));

  for (let index = 0; index < 3; index += 1) {
    await chooseAndSubmit(learners[index].page);
    await expect(powerpoint.page.locator('.response-footer > div').first()).toContainText(`${index + 1} / 4`);
  }
  await chooseAndSubmit(learners[3].page);
  await expect(powerpoint.page.locator('.poll-stage')).toBeVisible();
  await expect(powerpoint.page.getByText('Résultats en direct')).toBeVisible();

  const state = await powerpoint.context.request.get(`/api/quality/presentation/state?code=${code}`);
  expect(await state.json()).toMatchObject({ status:'polling', joined_count:4, answered_count:4 });
  await closeAll([...learners,powerpoint]);
});

test('la fin du chrono affiche le sondage même avec trois réponses sur quatre', async ({ browser, baseURL }) => {
  const code = 'TIMR3OF4';
  const sessionId = await createSession(code);
  const learners = await joinLearners(browser, baseURL, code, 4);
  await approveAll(sessionId);
  const powerpoint = await openPowerPoint(browser, baseURL, code);
  await startQuestion(sessionId, 5);
  await Promise.all(learners.map(learner => openLearner(learner, code)));

  for (let index = 0; index < 3; index += 1) await chooseAndSubmit(learners[index].page);
  await expect(powerpoint.page.locator('.response-footer > div').first()).toContainText('3 / 4');
  await expect(powerpoint.page.locator('.poll-stage')).toBeVisible({ timeout:12_000 });

  const state = await powerpoint.context.request.get(`/api/quality/presentation/state?code=${code}`);
  expect(await state.json()).toMatchObject({ status:'polling', joined_count:4, answered_count:3 });
  await closeAll([...learners,powerpoint]);
});

test('un échec réseau ne prétend plus que la réponse est enregistrée et permet de réessayer', async ({ browser, baseURL }) => {
  const code = 'RETRY001';
  const sessionId = await createSession(code);
  const [learner] = await joinLearners(browser, baseURL, code, 1);
  await approveAll(sessionId);
  await startQuestion(sessionId, 30);
  await openLearner(learner, code);

  let firstSubmission = true;
  await learner.page.route('**/api/learner/answers', async route => {
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

  await learner.page.unroute('**/api/learner/answers');
  await learner.page.locator('#validate').click();
  await expect(learner.page.locator('#validate')).toHaveText(/Réponse (enregistrée|validée)/);
  const result = await pool.query(
    'SELECT count(*)::integer AS count FROM live_answer_submissions WHERE session_id=$1',
    [sessionId]
  );
  expect(result.rows[0].count).toBe(1);
  await closeAll([learner]);
});
