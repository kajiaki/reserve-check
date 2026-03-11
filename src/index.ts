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

// メール設定（環境変数から取得）
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = process.env.EMAIL_TO;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;

// 特定の日付指定（環境変数から取得。例: "2026-04-11, 2026-04-12"）
const TARGET_DATES = process.env.TARGET_DATES ? process.env.TARGET_DATES.split(',').map(d => d.trim()) : [];

const BASE_URL = 'https://yoyaku-nishi.growone.net/sportsnet/Welcome.cgi';

async function sendEmail(message: string) {
  if (!EMAIL_USER || !EMAIL_PASS || !EMAIL_TO) {
    console.log('Email configuration is not set. Outputting to console instead:');
    console.log(message);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
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
      await page.check('input#catSel1_1'); // 体育室
      await page.check(`input#${gym.id}`);
      await page.click('button:has-text("選択した条件で次へ")');

      const halfCourtRow = page.locator('tr', { hasText: '体育室半面' });
      const checkbox = halfCourtRow.locator('input[type="checkbox"]');
      if (await checkbox.count() > 0) {
        await checkbox.first().check();
        await page.click('button:has-text("選択した施設で検索")');

        await page.check('input#dispDayKbn_2'); // 31日間
        await page.click('button:has-text("選択した条件で表示")');
        await page.waitForLoadState('networkidle');

        const gymResults = await scrapeCalendar(page, gym.name);
        if (gymResults) allResults.push(gymResults);
      }
    } catch (error) {
      console.error(`Error checking ${gym.name}: ${error}`);
    }
  }

  await browser.close();

  if (allResults.length > 0) {
    const message = '西宮市の体育館に空きが見つかりました。\n\n' + allResults.join('\n\n');
    await sendEmail(message);
  } else {
    console.log('No available slots found.');
  }
}

async function scrapeCalendar(page: Page, gymName: string): Promise<string | null> {
  const availability = await page.evaluate(() => {
    const results: { date: string, time: string, status: string }[] = [];
    const table = document.querySelector('table');
    if (!table) return results;

    const headers = Array.from(table.querySelectorAll('thead th, tr:first-child th')).slice(1);
    const dateList = headers.map(h => {
      const text = h.innerText.replace(/\s+/g, '');
      const match = text.match(/(\d+)月(\d+)日/);
      return match ? { month: parseInt(match[1]), day: parseInt(match[2]) } : null;
    });

    const rows = Array.from(table.querySelectorAll('tbody tr, tr')).filter(r => r.querySelector('th[scope="row"]'));
    
    rows.forEach(row => {
      const timeRange = (row.querySelector('th') as HTMLElement).innerText.trim();
      const startHour = parseInt(timeRange.split(':')[0]);

      if (startHour >= 8 && startHour < 18) {
        const cells = Array.from(row.querySelectorAll('td'));
        cells.forEach((cell, index) => {
          const dateInfo = dateList[index];
          if (!dateInfo) return;

          const img = cell.querySelector('img');
          const alt = img?.getAttribute('alt') || '';
          
          if (alt.includes('空いています')) {
            const countText = cell.innerText.trim();
            results.push({
              date: `${dateInfo.month}/${dateInfo.day}`,
              time: timeRange,
              status: countText || '○'
            });
          }
        });
      }
    });
    return results;
  });

  const year = new Date().getFullYear();
  const filtered = availability.filter(a => {
    const [month, day] = a.date.split('/').map(Number);
    const date = new Date(year, month - 1, day);
    const dateStr = format(date, 'yyyy-MM-dd');

    // 1. 指定日付がある場合、それに一致するか
    if (TARGET_DATES.length > 0) {
      return TARGET_DATES.includes(dateStr);
    }
    // 2. 指定がない場合は、土日祝日を対象にする
    return isSaturday(date) || isSunday(date) || !!JapaneseHolidays.isHoliday(date);
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
