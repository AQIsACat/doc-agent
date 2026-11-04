// src/lib/pdf.ts
import { PDFParse } from 'pdf-parse'; // 注意这里改成了命名导入

export async function extractPdfText(filePath: string): Promise<string> {
  try {
    const fs = await import('node:fs/promises');
    const dataBuffer = await fs.readFile(filePath);
    // 2.x 的用法：先 new 一个实例，再调 getText()
    const parser = new PDFParse({ data: dataBuffer });
    const result = await parser.getText();
    return result.text;
  } catch (error) {
    console.error('[pdf] parse error:', error);
    throw new Error('PDF 解析失败');
  }
}