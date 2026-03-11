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
      
      await page.evaluate((gymId) => {
        (document.querySelector('input#catSel1_1') as HTMLElement)?.click();
        (document.querySelector(`input#${gymId}`) as HTMLElement)?.click();
      }, gym.id);
      await page.click('button:has-text("選択した条件で次へ")');

      const foundHalf = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('tr'));
        const halfRow = rows.find(r => r.innerText.includes('体育室半面'));
        const cb = halfRow?.querySelector('input[type="checkbox"]') as HTMLElement;
        if (cb) { cb.click(); return true; }
        return false;
      });

      if (foundHalf) {
        await page.click('button:has-text("選択した施設で検索")');

        await page.evaluate(() => {
          (document.querySelector('input#dispDayKbn_2') as HTMLElement)?.click();
        });
        await page.click('button:has-text("選択した条件で表示")');
        await page.waitForLoadState('networkidle');

        // 1ヶ月目（本日〜31日分）をチェック
        let combinedSlots = await scrapeCalendar(page);
        
        // 「次の31日分」ボタンがあるか確認してクリック（最大5秒待機）
        const nextButton = page.locator('button:has-text("次の31日分")');
        try {
          if (await nextButton.isVisible({ timeout: 5000 })) {
            await nextButton.click();
            await page.waitForLoadState('networkidle');
            const secondMonthSlots = await scrapeCalendar(page);
            combinedSlots = [...combinedSlots, ...secondMonthSlots];
          }
        } catch (e) {
          console.log(`  Next month button not found or not clickable for ${gym.name}. Skipping.`);
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
    const message = '西宮市の体育館に空きが見見つかりました。\n\n' + allResults.join('\n\n');
    await sendEmail(message);
  } else {
    console.log('No available slots found.');
  }
}

async function scrapeCalendar(page: Page): Promise<{ date: string, time: string, status: string }[]> {
  return await page.evaluate(() => {
    const results: { date: string, time: string, status: string }[] = [];
    const table = document.querySelector('table');
    if (!table) return results;

    const headers = Array.from(table.querySelectorAll('th')).filter(h => h.innerText.includes('月'));
    const dateList = headers.map(h => {
      const text = h.innerText.replace(/\s+/g, '');
      const match = text.match(/(\d+)月(\d+)日/);
      return match ? { month: parseInt(match[1]), day: parseInt(match[2]) } : null;
    });

    const rows = Array.from(table.querySelectorAll('tr')).filter(r => r.querySelector('th[scope="row"]'));
    rows.forEach(row => {
      const timeRange = (row.querySelector('th') as HTMLElement).innerText.trim();
      const cells = Array.from(row.querySelectorAll('td'));
      cells.forEach((cell, index) => {
        const dateInfo = dateList[index];
        if (!dateInfo) return;
        const img = cell.querySelector('img');
        const alt = img?.getAttribute('alt') || '';
        if (alt.includes('空いています')) {
          results.push({
            date: `${dateInfo.month}/${dateInfo.day}`,
            time: timeRange,
            status: cell.innerText.trim() || '○'
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
    const targetYear = (month < currentMonth) ? year + 1 : year;
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
