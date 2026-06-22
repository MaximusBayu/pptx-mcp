// Mirrors engine/src/pptx_mcp/autodetect.py estimate_max_chars — keep in sync.
// bbox w/h are percent of slide WIDTH / HEIGHT respectively.
const GLYPH_W = 0.5;
const LINE_H = 1.2;
const EMU_PER_PT = 12700;
export const DEFAULT_FONT_PT = 18;

export function estimateMaxChars(
  wPct: number,
  hPct: number,
  slideWemu: number,
  slideHemu: number,
  fontPt: number | null | undefined,
): number {
  const pt = fontPt && fontPt > 0 ? fontPt : DEFAULT_FONT_PT;
  const fontEmu = pt * EMU_PER_PT;
  const widthEmu = (slideWemu * wPct) / 100;
  const heightEmu = (slideHemu * hPct) / 100;
  const charsPerLine = Math.max(1, Math.floor(widthEmu / (fontEmu * GLYPH_W)));
  const lines = Math.max(1, Math.floor(heightEmu / (fontEmu * LINE_H)));
  return charsPerLine * lines;
}
