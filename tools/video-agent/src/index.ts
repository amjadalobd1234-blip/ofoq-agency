import 'dotenv/config';
import * as readline from 'node:readline';
import path from 'node:path';
import { generateVideoConfig } from './groq';
import { renderVideo } from './render';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('اكتب وصف الفيديو: ', async (description) => {
  // No further input is needed while the API call and render run.
  rl.close();
  console.log('\nجاري التحليل...');
  try {
    const config = await generateVideoConfig(description);
    console.log('فهمت الطلب:', config);
    console.log('\nجاري إنشاء الفيديو...');
    const outputPath = await renderVideo(config);
    console.log(`\nالفيديو جاهز: ${path.relative(process.cwd(), outputPath)}`);
  } catch (error) {
    console.error('خطأ:', error instanceof Error ? error.message : 'تعذّر إنشاء الفيديو.');
    process.exitCode = 1;
  }
});
