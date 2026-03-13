import { chromium, Page } from 'playwright';
import nodemailer from 'nodemailer';
import { isSaturday, isSunday, format, addDays } from 'date-fns';
import { ja } from 'date-fns/locale';
import * as JapaneseHolidays from 'japanese-holidays';

const TARGET_GYMS = [
  { id: 'catSel3_3', name: '今津体育館' },
  { id: 'catSel3_4', name: '鳴尾体育館' },
  { id: 'catSel3_5', name: '甲武体育館' },
  { id: 'catSel3_6', name: '北夙川体育館' },
  { id: 'catSel3_10', name: '流通東体育館' },
  { id: 'catSel3_16', name: '浜甲子園体育館' },
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

  console.log("一括空き状況確認を開始します...");
  
  if (TARGET_DATE_CONFIGS.length > 0) {
    console.log("対象日設定:");
    TARGET_DATE_CONFIGS.forEach(c => console.log(`  - ${c.date} (${c.startHour}:00 - ${c.endHour}:00)`));
  } else {
    console.log("対象日設定なし: 土日祝の 08:00 - 18:00 をチェックします。");
  }

  try {
    await page.goto(BASE_URL);
    await page.click('text=ログインせずに空き状況を検索');

    console.log("検索条件を一括設定中...");
    await page.evaluate((gymIds) => {
      const mode1 = document.querySelector('input#yoyakuMode_1') as HTMLInputElement;
      if (mode1) mode1.click();
      const catGym = document.querySelector('input#catSel1_1') as HTMLInputElement;
      if (catGym) catGym.click();
      const miniBasket = document.querySelector('input#genSel1_6') as HTMLInputElement;
      if (miniBasket) miniBasket.click();
      gymIds.forEach(id => {
        const box = document.querySelector(`input#${id}`) as HTMLInputElement;
        if (box && !box.checked) box.click();
      });
    }, TARGET_GYMS.map(g => g.id));

    await page.waitForTimeout(1000);
    await page.locator('button, input[type="button"]').filter({ hasText: '選択した条件で次へ' }).first().click();
    await page.waitForLoadState('networkidle');

    const count = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr, div[row]'));
      let selected = 0;
      rows.forEach(row => {
        if ((row as HTMLElement).innerText && (row as HTMLElement).innerText.includes('体育室半面')) {
          const cb = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
          if (cb && !cb.checked) {
            cb.click();
            selected++;
          }
        }
      });
      return selected;
    });
    console.log(`${count} 個の施設を選択しました。検索を開始します。`);
    
    await page.locator('button, input[type="button"]').filter({ hasText: '選択した施設で検索' }).first().click();
    await page.waitForLoadState('networkidle');

    let allExtractedSlots: any[] = [];
    for (let i = 0; i < 8; i++) {
      const dateRange = await page.evaluate(() => {
        const ths = Array.from(document.querySelectorAll('table tr:first-child th')).slice(1);
        const dates = ths.map(th => (th as HTMLElement).innerText.replace(/\s+/g, ''));
        return dates.length > 0 ? `${dates[0]} ～ ${dates[dates.length - 1]}` : "不明";
      });
      
      console.log(`${i + 1}週目のデータを取得中: ${dateRange}`);
      const slots = await scrapeCalendarBatch(page);
      allExtractedSlots = [...allExtractedSlots, ...slots];
      
      const nextBtn = page.locator('a, button').filter({ hasText: '次の7日分' }).first();
      if (await nextBtn.isVisible()) {
        await nextBtn.click();
        await page.waitForTimeout(2000);
      } else {
        break;
      }
    }

    console.log(`合計 ${allExtractedSlots.length} 件の空き枠候補を抽出しました。フィルタリング中...`);

    const allResults: string[] = [];
    const gymNamesFound = [...new Set(allExtractedSlots.map(s => s.gymName))];
    
    for (const name of gymNamesFound) {
      const gymSlots = allExtractedSlots.filter(s => s.gymName === name);
      const gymResults = processResults(name, gymSlots);
      if (gymResults) allResults.push(gymResults);
    }

    if (allResults.length > 0) {
      const message = '西宮市の体育館（半面）に空きが見つかりました。\n\n' + allResults.join('\n\n');
      await sendEmail(message);
    } else {
      console.log('条件に合う空きは見つかりませんでした。');
    }

  } catch (error) {
    console.error(`一括チェック中にエラーが発生しました: ${error}`);
  } finally {
    await browser.close();
  }
}

async function scrapeCalendarBatch(page: Page): Promise<{ gymName: string, date: string, time: string, status: string }[]> {
  return await page.evaluate(() => {
    const results: { gymName: string, date: string, time: string, status: string }[] = [];
    // 全ての h3 (体育館名) を取得
    const h3s = Array.from(document.querySelectorAll('h3'));
    
    h3s.forEach(h3 => {
      const gymName = h3.innerText.trim();
      
      // h3 の次にある table を探す。h3 と table の間に div や a が挟まっている可能性がある。
      let parent = h3.parentElement;
      if (!parent) return;
      
      // 体育館セクション内のテーブルを特定
      // 構造的には h3 があり、その後に施設詳細リンクがあり、その後にテーブルがある
      let table: HTMLTableElement | null = null;
      let next = h3.nextElementSibling;
      while (next) {
        if (next.tagName === 'TABLE') {
          table = next as HTMLTableElement;
          break;
        }
        // もし次の h3 に当たってしまったら、この体育館のカレンダーはないと判断
        if (next.tagName === 'H3') break;
        
        // テーブルが入れ子になっている可能性も考慮
        const nestedTable = next.querySelector('table');
        if (nestedTable) {
          table = nestedTable as HTMLTableElement;
          break;
        }
        next = next.nextElementSibling;
      }
      
      if (!table) return;

      const rows = Array.from(table.querySelectorAll('tr'));
      if (rows.length < 2) return;

      // 日付ヘッダーの解析 (1行目の th 群)
      const headerThs = Array.from(rows[0].querySelectorAll('th')).slice(1);
      const dateList = headerThs.map(th => {
        const text = th.innerText.replace(/\s+/g, '');
        const match = text.match(/(\d+)月(\d+)日/);
        return match ? { month: parseInt(match[1]), day: parseInt(match[2]) } : null;
      });

      // 2行目以降（時間帯行）の解析
      rows.slice(1).forEach(row => {
        const timeTh = row.querySelector('th');
        if (!timeTh) return;
        
        const timeRange = timeTh.innerText.trim();
        if (!timeRange.includes(':')) return;

        const tds = Array.from(row.querySelectorAll('td'));
        tds.forEach((td, index) => {
          const dateInfo = dateList[index];
          if (!dateInfo) return;

          // td 内の全ての img をチェック
          const imgs = Array.from(td.querySelectorAll('img'));
          const hasVacancy = imgs.some(img => {
            const alt = img.getAttribute('alt') || '';
            const src = img.getAttribute('src') || '';
            return alt.includes('空いています') || src.includes('icn_scche_ok');
          });
          
          if (hasVacancy) {
            results.push({
              gymName,
              date: `${dateInfo.month}/${dateInfo.day}`,
              time: timeRange,
              status: td.innerText.replace(/\s+/g, ' ').trim() || '○'
            });
          }
        });
      });
    });
    return results;
  });
}

function processResults(gymName: string, availability: { date: string, time: string, status: string }[]): string | null {
  const year = new Date().getFullYear();
  const now = new Date();
  const currentMonth = now.getMonth() + 1;

  const uniqueSlots = availability.filter((v, i, a) => 
    a.findIndex(t => t.date === v.date && t.time === v.time) === i
  );

  const filtered = uniqueSlots.filter(a => {
    const [month, day] = a.date.split('/').map(Number);
    const targetYear = (month < currentMonth - 2) ? year + 1 : year;
    const date = new Date(targetYear, month - 1, day);
    const dateStr = format(date, 'yyyy-MM-dd');

    const startHourText = a.time.split(':')[0];
    const startHour = parseInt(startHourText);

    const isHoliday = !!JapaneseHolidays.isHoliday(date);
    const isTargetDay = isSaturday(date) || isSunday(date) || isHoliday;

    // 特定の指定日設定がある場合
    const specificConfig = TARGET_DATE_CONFIGS.find(c => c.date === dateStr);
    if (specificConfig) {
      const match = startHour >= specificConfig.startHour && startHour < specificConfig.endHour;
      return match;
    }

    // 設定がない場合は土日祝の 8:00-18:00
    if (TARGET_DATE_CONFIGS.length === 0) {
      if (isTargetDay) {
        return startHour >= 8 && startHour < 18;
      }
    } else {
      // 指定日リストにあるが時間指定がない場合は、日付が一致していれば通す
      if (TARGET_DATE_CONFIGS.some(c => c.date === dateStr)) {
        return true;
      }
    }
    return false;
  });

  if (filtered.length === 0) return null;

  const grouped = filtered.reduce((acc, curr) => {
    const [month, day] = curr.date.split('/').map(Number);
    const targetYear = (month < currentMonth - 2) ? year + 1 : year;
    const date = new Date(targetYear, month - 1, day);
    const dateWithDay = format(date, 'M/d(E)', { locale: ja });

    if (!acc[dateWithDay]) acc[dateWithDay] = [];
    acc[dateWithDay].push(`・${curr.time} (空き: ${curr.status})`);
    return acc;
  }, {} as Record<string, string[]>);

  const lines = Object.entries(grouped).map(([date, slots]) => `${date}\n${slots.join('\n')}`);
  return `【${gymName}】\n${lines.join('\n')}`;
}

checkGymAvailability().catch(console.error);
