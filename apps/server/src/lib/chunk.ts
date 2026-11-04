export type Chunk = {
  content: string;
  index: number;
};

/**
 * 将长文本切分成小块
 * @param text 原始长文本
 * @param maxLength 每个 chunk 的最大字符数（默认 500）
 * @param overlap 相邻 chunk 的重叠字符数（默认 50，保证语义不断）
 */
export function splitText(text: string, maxLength = 500, overlap = 50): Chunk[] {
  // 1. 先按双换行（段落）切分，过滤掉空行
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  
  const chunks: Chunk[] = [];
  let currentChunk = '';
  let index = 0;

  for (const p of paragraphs) {
    // 如果当前段落加上去还没超长，就拼在一起
    if (currentChunk.length + p.length <= maxLength) {
      currentChunk += (currentChunk ? '\n\n' : '') + p;
    } else {
      // 放不下了，先把之前的存起来
      if (currentChunk) {
        chunks.push({ content: currentChunk, index: index++ });
      }

      // 如果单个段落自己就超过了 maxLength，硬切
      if (p.length > maxLength) {
        let start = 0;
        while (start < p.length) {
          const end = Math.min(start + maxLength, p.length);
          chunks.push({ content: p.slice(start, end), index: index++ });
          start = end - overlap; // 保留重叠部分
        }
        currentChunk = ''; // 硬切完了，重置
      } else {
        // 单个段落没超长，但加上之前的内容超长了，所以自己开一个新块
        // 为了重叠，可以带上前一个块的结尾部分（这里简化，直接新起）
        currentChunk = p;
      }
    }
  }

  // 把最后剩下的一块存起来
  if (currentChunk) {
    chunks.push({ content: currentChunk, index: index++ });
  }

  return chunks;
}