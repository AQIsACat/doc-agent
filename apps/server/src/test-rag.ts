import { extractPdfText } from './lib/pdf.js';
import { splitText } from './lib/chunk.js';

async function main() {
  console.log('开始解析 PDF...');
  const text = await extractPdfText('test.pdf');
  console.log(`解析成功，总字符数: ${text.length}`);

  console.log('开始切分...');
  const chunks = splitText(text);
  console.log(`切分完成，共 ${chunks.length} 块`);

  // 打印前两块看看效果
  console.log('--- 第 1 块 ---');
  console.log(chunks[0]?.content);
  console.log('--- 第 2 块 ---');
  console.log(chunks[1]?.content);
}

main().catch(console.error);