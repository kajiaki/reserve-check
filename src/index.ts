import { chromium, Page } from 'playwright';
import nodemailer from 'nodemailer';
import { isSaturday, isSunday, format } from 'date-fns';
import * as JapaneseHolidays from 'japanese-holidays';

const TARGET_GYMS = [
  { id: 'catSel3_3', name: '今津体育館' },
  { id: 'catSel3_4', name: '鳴尾体育館' },
  { id: 'catSel3_5', name: '甲武体育館' },
  { id: 'catSel3_6', name: '北夙川体育館' },
  { id: 'catSel3_10', name: '流通東体育館' },
  { id: 'catSel3_17', name: '松原体育館' },
];

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = process.env.EMAIL_TO;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;

interface TargetDateConfig {
  date: string;
  startHour: number;
  endHour: number;
}

const TARGET_DATE_CONFIGS: TargetDateConfig[] = (process.env.TARGET_DATES || '')
  .split(',')
  .map(item => item.trim())
  .filter(item => item !== '')
  .map(item => {
    const [date, timeRange] = item.split(':');
    let startHour = 8;
    let endHour = 18;
    if (timeRange) {
      const [s, e] = timeRange.split('-').map(Number);
      if (!isNaN(s)) startHour = s;
      if (!isNaN(e)) endHour = e;
    }
    return { date, startHour, endHour };
  });

const BASE_URL = 'https://yoyaku-nishi.growone.net/sportsnet/Welcome.cgi';

async function sendEmail(message: string) {
  if (!EMAIL_USER || !EMAIL_PASS || !EMAIL_TO) {
    console.log('Email configuration is not set. Outputting to console instead:');
    console.log(message);
    return;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
  try {
    await transporter.sendMail({
      from: `"西宮体育館予約チェッカー" <${EMAIL_USER}>`,
      to: EMAIL_TO,
      subject: '【空き情報】西宮市体育館予約',
      text: message,
    });
    console.log('Email notification sent successfully.');
  } catch (error) {
    console.error('Failed to send email notification:', error);
  }
}

async function checkGymAvailability() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const allResults: string[] = [];

  for (const gym of TARGET_GYMS) {
    console.log(`Checking ${gym.name}...`);
    try {
      await page.goto(BASE_URL);
      await page.click('text=ログインせずに空き状況を検索');
      
      // モード選択（空き照会）とカテゴリ選択を確実に行う
      await page.evaluate(async (gymId) => {
        // 1. 「施設の空き照会／予約申込」を選択
        const yoyakuMode = document.querySelector('input#yoyakuMode_1') as HTMLElement;
        if (yoyakuMode) yoyakuMode.click();

        await new Promise(r => setTimeout(r, 500));

        // 2. 「体育室」を選択
        const catGym = document.querySelector('input#catSel1_1') as HTMLElement;
        if (catGym) catGym.click();
        
        await new Promise(r => setTimeout(r, 1000));
        
        // 3. 「バスケットボール」を選択
        const basket = document.querySelector('input#genSel1_5') as HTMLElement;
        if (basket) basket.click();
        
        // 4. 「体育館」を選択
        const targetGym = document.querySelector(`input#${gymId}`) as HTMLElement;
        if (targetGym) targetGym.click();
      }, gym.id);
      
      await page.waitForTimeout(1000);
      await page.click('button:has-text("選択した条件で次へ")');

      // 5. 「体育室半面」を選択
      const foundHalf = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('tr'));
        const halfRow = rows.find(r => r.innerText.includes('体育室半面'));
        const cb = halfRow?.querySelector('input[type="checkbox"]') as HTMLElement;
        if (cb) { cb.click(); return true; }
        return false;
      });

      if (foundHalf) {
        await page.click('button:has-text("選択した施設で検索")');

        await page.waitForSelector('input#dispDayKbn_2');
        await page.evaluate(() => {
          (document.querySelector('input#dispDayKbn_2') as HTMLElement)?.click();
        });
        await page.click('button:has-text("選択した条件で表示")');
        await page.waitForTimeout(2000);

        let combinedSlots = await scrapeCalendar(page);
        
        const nextButton = page.locator('a:has-text("次の31日分"), button:has-text("次の31日分")');
        if (await nextButton.isVisible({ timeout: 3000 })) {
          await nextButton.click();
          await page.waitForTimeout(2000);
          const secondMonthSlots = await scrapeCalendar(page);
          combinedSlots = [...combinedSlots, ...secondMonthSlots];
        }

        const gymResults = processResults(gym.name, combinedSlots);
        if (gymResults) allResults.push(gymResults);
      }
    } catch (error) {
      console.error(`Error checking ${gym.name}: ${error}`);
    }
  }

  await browser.close();

  if (allResults.length > 0) {
    const message = '西宮市の体育館（バスケ・半面）に空きが見つかりました。\n\n' + allResults.join('\n\n');
    await sendEmail(message);
  } else {
    console.log('No available slots found.');
  }
}

async function scrapeCalendar(page: Page): Promise<{ date: string, time: string, status: string }[]> {
  return await page.evaluate(() => {
    const results: { date: string, time: string, status: string }[] = [];
    const tables = Array.from(document.querySelectorAll('table'));
    const table = tables.find(t => t.innerText.includes('月') && t.innerText.includes('日'));
    if (!table) return results;

    const allThs = Array.from(table.querySelectorAll('th'));
    const dateList: { month: number, day: number }[] = [];
    
    allThs.forEach(th => {
      const text = th.innerText.replace(/\s+/g, '');
      const match = text.match(/(\d+)月(\d+)日/);
      if (match) {
        dateList.push({ month: parseInt(match[1]), day: parseInt(match[2]) });
      }
    });

    if (dateList.length === 0) return results;

    const rows = Array.from(table.querySelectorAll('tr')).filter(r => r.querySelector('th[scope="row"]'));
    
    rows.forEach(row => {
      const timeRangeTh = row.querySelector('th[scope="row"]') as HTMLElement;
      const timeRange = timeRangeTh.innerText.trim();
      
      const tds = Array.from(row.querySelectorAll('td'));
      tds.forEach((td, index) => {
        if (index >= dateList.length) return;
        
        const img = td.querySelector('img');
        const alt = img?.getAttribute('alt') || '';
        const src = img?.getAttribute('src') || '';
        
        if (alt.includes('空いています') || src.includes('icn_scche_ok')) {
          const dateInfo = dateList[index];
          results.push({
            date: `${dateInfo.month}/${dateInfo.day}`,
            time: timeRange,
            status: td.innerText.trim() || '○'
          });
        }
      });
    });
    return results;
  });
}

function processResults(gymName: string, availability: { date: string, time: string, status: string }[]): string | null {
  const year = new Date().getFullYear();
  const now = new Date();
  const currentMonth = now.getMonth() + 1;

  const filtered = availability.filter(a => {
    const [month, day] = a.date.split('/').map(Number);
    const targetYear = (month < currentMonth - 2) ? year + 1 : year;
    const date = new Date(targetYear, month - 1, day);
    const dateStr = format(date, 'yyyy-MM-dd');

    const startHour = parseInt(a.time.split(':')[0]);

    const specificConfig = TARGET_DATE_CONFIGS.find(c => c.date === dateStr);
    if (specificConfig) {
      return startHour >= specificConfig.startHour && startHour < specificConfig.endHour;
    }

    if (TARGET_DATE_CONFIGS.length === 0) {
      if (isSaturday(date) || isSunday(date) || !!JapaneseHolidays.isHoliday(date)) {
        return startHour >= 8 && startHour < 18;
      }
    }
    return false;
  });

  if (filtered.length === 0) return null;

  const grouped = filtered.reduce((acc, curr) => {
    if (!acc[curr.date]) acc[curr.date] = [];
    acc[curr.date].push(`・${curr.time} (空き: ${curr.status})`);
    return acc;
  }, {} as Record<string, string[]>);

  const lines = Object.entries(grouped).map(([date, slots]) => `${date}\n${slots.join('\n')}`);
  return `【${gymName}】\n${lines.join('\n')}`;
}

checkGymAvailability().catch(console.error);
