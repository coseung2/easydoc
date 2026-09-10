/** All SDK-specific types/quirks stay here; editor code never depends on this model. */
import {
  BlankFileMaker,
  HWPXWriter,
  Para,
  Picture,
  TableFromArray,
  DropCapStyle,
  LineType2,
  LineWidth,
  NumberingType,
  TablePageBreak,
  TextDirection,
  TextFlowSide,
  TextWrapMethod,
  VertAlign,
} from 'ownhwpx'
import type { ShapeObject } from 'ownhwpx'
import { HorizontalAlign2 } from 'ownhwpx/object/content/header_xml/enumtype/HorizontalAlign2'
import { LineSpacingType } from 'ownhwpx/object/content/header_xml/enumtype/LineSpacingType'
import { ValueUnit2 } from 'ownhwpx/object/content/header_xml/enumtype/ValueUnit2'
import { UnderlineType } from 'ownhwpx/object/content/header_xml/enumtype/UnderlineType'
import { WidthRelTo } from 'ownhwpx/object/content/section_xml/enumtype/WidthRelTo'
import { HeightRelTo } from 'ownhwpx/object/content/section_xml/enumtype/HeightRelTo'
import { VertRelTo } from 'ownhwpx/object/content/section_xml/enumtype/VertRelTo'
import { HorzRelTo } from 'ownhwpx/object/content/section_xml/enumtype/HorzRelTo'
import { HorzAlign } from 'ownhwpx/object/content/section_xml/enumtype/HorzAlign'
import { PageDirection } from 'ownhwpx/object/content/section_xml/enumtype/PageDirection'
import { DEFAULT_TEXT_STYLE, HWPX_LIMITS, distributeWidths } from './model'
import type { GeneratedDocument, ImageRun, Paragraph, TableBlock, TextStyle } from './model'

// HWPUNIT = 1/100 pt. A4 portrait, 20 mm margins. Fonts are referenced, never bundled.
export const HWPX_PAGE = { width: 59528, height: 84189, margin: 5669 } as const
const CONTENT_WIDTH = HWPX_PAGE.width - HWPX_PAGE.margin * 2
const CONTENT_HEIGHT = HWPX_PAGE.height - HWPX_PAGE.margin * 2
const STAMP = new Date('2000-01-01T00:00:00Z')

export interface HwpxWriteOptions {
  title: string
  /** Fixed in tests; the caller supplies creation time for user-facing exports. */
  createdAt?: Date
}

export function writeOwnHwpx(document: GeneratedDocument, options: HwpxWriteOptions): Uint8Array {
  const doc = BlankFileMaker.make()
  const refs = doc.headerXMLFile.refList!
  const section = doc.sectionXMLFileList.get(0)
  const first = section.paraListCore.getPara(0)
  const sectionRun = first.getRun(0)
  const page = sectionRun.secPr!.pagePr!
  page.width = HWPX_PAGE.width
  page.height = HWPX_PAGE.height
  page.landscape = PageDirection.WIDELY
  page.margin!.left = page.margin!.right = page.margin!.top = page.margin!.bottom = HWPX_PAGE.margin
  page.margin!.header = page.margin!.footer = 2835
  doc.settingsXMLFile.caretPosition!.pos = 0
  doc.versionXMLFile.applicationAnd('EasyDoc').appVersionAnd('0.1.0')
  doc.contentHPFFile.metaData.title!.addText(options.title)
  const created = (options.createdAt ?? STAMP).toISOString()
  for (const meta of doc.contentHPFFile.metaData.metaList) {
    if (['CreatedDate', 'ModifiedDate', 'date'].includes(meta.name ?? '')) meta.text = created
    if (['creator', 'lastsaveby'].includes(meta.name ?? '')) meta.text = 'EasyDoc'
  }

  // The SDK blank template contains unused legacy styles with dangling paragraph
  // references. Keep the normal style and register only styles used by our output.
  refs.charProperties.splice(1)
  const basePara = refs.paraProperties[3]!
  basePara.id = '0'
  refs.paraProperties.splice(0, refs.paraProperties.length, basePara)
  refs.styles.splice(1)
  // This MVP writes visible list markers, not automatic numbering definitions.
  refs.numberings.splice(0)
  refs.bullets.splice(0)
  refs.styles[0]!.paraPrIDRef = '0'
  refs.styles[0]!.charPrIDRef = '0'

  let serial = 1,
    pictureSerial = 1
  let firstUsed = false
  const charIds = new Map<string, string>()
  const paraIds = new Map<string, string>()
  const styleIds = new Map<string, string>()
  const fontIds = new Map<string, string>([
    ['함초롬돋움', '0'],
    ['함초롬바탕', '1'],
  ])
  section.paraListCore.removeAllParas()

  function fontId(font: string): string {
    const found = fontIds.get(font)
    if (found) return found
    if (fontIds.size >= 32) throw new Error('Too many HWPX font families.')
    const id = String(fontIds.size)
    for (const face of refs.fontfaces!.fontfaceList) {
      const entry = face.addNewFont()
      entry.id = id
      entry.face = font
      entry.type = face.fontList[0]!.type
      entry.isEmbedded = false
    }
    fontIds.set(font, id)
    return id
  }

  function charId(style: TextStyle): string {
    const key = JSON.stringify(style)
    const found = charIds.get(key)
    if (found) return found
    if (charIds.size >= HWPX_LIMITS.styleVariants)
      throw new Error('Too many HWPX character styles.')
    // Public SDK factory supplies complete default child properties. The number
    // of variants is bounded; no private SDK fields are cloned or mutated.
    const char = BlankFileMaker.make().headerXMLFile.refList!.charProperties[0]!
    const id = String(refs.charProperties.length)
    char.id = id
    char.height = Math.round(style.sizePt * 100)
    char.textColor = style.color
    const font = fontId(style.font)
    const fontRef = char.fontRef!
    fontRef.hangul =
      fontRef.latin =
      fontRef.hanja =
      fontRef.japanese =
      fontRef.other =
      fontRef.symbol =
      fontRef.user =
        font
    if (style.bold) char.createBold()
    if (style.italic) char.createItalic()
    char.underline!.type = style.underline ? UnderlineType.BOTTOM : UnderlineType.NONE
    if (style.strike) {
      char.createStrikeout().shape = LineType2.SOLID
      char.strikeout!.color = style.color
    }
    refs.charProperties.push(char)
    charIds.set(key, id)
    return id
  }

  function paraId(p: Paragraph): string {
    const key = JSON.stringify([p.align, p.lineHeight, p.indent, p.heading])
    const found = paraIds.get(key)
    if (found) return found
    if (paraIds.size >= HWPX_LIMITS.styleVariants)
      throw new Error('Too many HWPX paragraph styles.')
    const pp = BlankFileMaker.make().headerXMLFile.refList!.paraProperties[3]!
    const id = String(refs.paraProperties.length)
    pp.id = id
    pp.align!.horizontal = {
      left: HorizontalAlign2.LEFT,
      center: HorizontalAlign2.CENTER,
      right: HorizontalAlign2.RIGHT,
      justify: HorizontalAlign2.JUSTIFY,
    }[p.align]
    pp.breakSetting!.keepWithNext = p.heading > 0
    pp.snapToGrid = false
    pp.removeSwitchList()
    const margin = pp.createMargin()
    margin.createIntent().valueAnd(0).unitAnd(ValueUnit2.HWPUNIT)
    margin
      .createLeft()
      .valueAnd(Math.min(p.indent, 8) * 1400)
      .unitAnd(ValueUnit2.HWPUNIT)
    margin.createRight().valueAnd(0).unitAnd(ValueUnit2.HWPUNIT)
    margin
      .createPrev()
      .valueAnd(p.heading ? 600 : 0)
      .unitAnd(ValueUnit2.HWPUNIT)
    margin
      .createNext()
      .valueAnd(p.heading ? 400 : 200)
      .unitAnd(ValueUnit2.HWPUNIT)
    pp.createLineSpacing()
      .typeAnd(LineSpacingType.PERCENT)
      .valueAnd(p.lineHeight)
      .unitAnd(ValueUnit2.HWPUNIT)
    refs.paraProperties.push(pp)
    paraIds.set(key, id)
    return id
  }

  function styleId(p: Paragraph, paragraphId: string): string {
    if (!p.heading) return '0'
    const key = `${p.heading}:${paragraphId}`
    const found = styleIds.get(key)
    if (found) return found
    const id = String(refs.styles.length)
    const style = refs.addNewStyle()
    style.id = id
    style.type = refs.styles[0]!.type
    style.name = `제목 ${p.heading}`
    style.engName = `Heading ${p.heading}`
    style.paraPrIDRef = paragraphId
    const run = p.runs.find((r) => r.kind === 'text')
    style.charPrIDRef = charId(run?.kind === 'text' ? run.style : DEFAULT_TEXT_STYLE)
    style.nextStyleIDRef = '0'
    style.langID = '1042'
    style.lockForm = false
    styleIds.set(key, id)
    return id
  }

  function placeShape<S extends ShapeObject<S>>(
    shape: S,
    width: number,
    height: number,
    numbering: NumberingType,
  ): void {
    shape.id = String(serial++)
    shape.zOrder = 0
    shape.numberingType = numbering
    shape.textWrap = TextWrapMethod.TOP_AND_BOTTOM
    shape.textFlow = TextFlowSide.BOTH_SIDES
    shape.lock = false
    shape.dropcapstyle = DropCapStyle.None
    shape
      .createSz()
      .widthAnd(width)
      .heightAnd(height)
      .widthRelToAnd(WidthRelTo.ABSOLUTE)
      .heightRelToAnd(HeightRelTo.ABSOLUTE)
      .protectAnd(false)
    shape
      .createPos()
      .treatAsCharAnd(true)
      .affectLSpacingAnd(false)
      .flowWithTextAnd(true)
      .allowOverlapAnd(false)
      .holdAnchorAndSOAnd(false)
      .vertRelToAnd(VertRelTo.PARA)
      .horzRelToAnd(HorzRelTo.PARA)
      .vertAlignAnd(VertAlign.TOP)
      .horzAlignAnd(HorzAlign.LEFT)
      .vertOffsetAnd(0)
      .horzOffsetAnd(0)
    shape.createOutMargin().leftAnd(0).rightAnd(0).topAnd(0).bottomAnd(0)
  }

  function picture(image: ImageRun, availableWidth: number): Picture {
    const scale = Math.min(
      1,
      availableWidth / (image.widthPx * 75),
      CONTENT_HEIGHT / (image.heightPx * 75),
    )
    const width = Math.max(1, Math.round(image.widthPx * 75 * scale))
    const height = Math.max(1, Math.round(image.heightPx * 75 * scale))
    const pic = new Picture()
    placeShape(pic, width, height, NumberingType.PICTURE)
    pic.instid = pic.id
    pic.groupLevel = 0
    pic.reverse = false
    pic.createOffset().xAnd(0).yAnd(0)
    pic.createOrgSz().widthAnd(width).heightAnd(height)
    pic.createCurSz().widthAnd(width).heightAnd(height)
    pic.createFlip().horizontalAnd(false).verticalAnd(false)
    pic
      .createRotationInfo()
      .angleAnd(0)
      .centerXAnd(Math.round(width / 2))
      .centerYAnd(Math.round(height / 2))
      .rotateimageAnd(true)
    const matrix = pic.createRenderingInfo()
    for (const m of [
      matrix.addNewTransMatrix(),
      matrix.addNewScaMatrix(),
      matrix.addNewRotMatrix(),
    ]) {
      m.e1And(1).e2And(0).e3And(0).e4And(0).e5And(1).e6And(0)
    }
    const rect = pic.createImgRect()
    rect.createPt0().xAnd(0).yAnd(0)
    rect.createPt1().xAnd(width).yAnd(0)
    rect.createPt2().xAnd(width).yAnd(height)
    rect.createPt3().xAnd(0).yAnd(height)
    pic.createImgClip().leftAnd(0).rightAnd(width).topAnd(0).bottomAnd(height)
    pic.createInMargin().leftAnd(0).rightAnd(0).topAnd(0).bottomAnd(0)
    pic
      .createImgDim()
      .dimwidthAnd(Math.round(image.widthPx))
      .dimheightAnd(Math.round(image.heightPx))
    const id = `image${pictureSerial++}`
    const item = doc.contentHPFFile.addNewManifest()
    item.id = id
    item.href = `BinData/${id}.${image.mime === 'image/png' ? 'png' : 'jpg'}`
    item.mediaType = image.mime
    item.attachedFileData = image.bytes
    item.embedded = true
    pic.createImg().binaryItemIDRefAnd(id).brightAnd(0).contrastAnd(0).alphaAnd(0)
    if (image.alt) pic.createShapeComment().addText(image.alt)
    return pic
  }

  function makeParagraph(p: Paragraph, inCell = false, availableWidth = CONTENT_WIDTH): Para {
    const para = !firstUsed && !inCell ? first : new Para()
    if (!inCell) firstUsed = true
    para.id = String(serial++)
    para.paraPrIDRef = paraId(p)
    para.styleIDRef = styleId(p, para.paraPrIDRef)
    para.pageBreak = para.columnBreak = para.merged = false
    para.lineSegArray.removeAll() // Hancom computes layout; do not retain blank-template caches.
    for (const inline of p.runs) {
      const run = para.addNewRun()
      if (inline.kind === 'image') {
        run.charPrIDRef = '0'
        run.addItem(picture(inline, availableWidth))
      } else {
        run.charPrIDRef = charId(inline.style)
        const text = run.addNewT()
        for (const part of inline.text.split(/(\n|\t)/)) {
          if (part === '\n') text.addNewLineBreak()
          else if (part === '\t') text.addNewTab()
          else if (part) text.addText(part)
        }
      }
    }
    if (!para.runList.length) para.addNewRun().charPrIDRefAnd('0').addNewT()
    return para
  }

  // Give tables a real visible border instead of the blank template's no-border fill.
  const border = refs.addNewBorderFill()
  border.id = String(refs.borderFills.length)
  border.threeD = border.shadow = false
  for (const side of [
    border.createLeftBorder(),
    border.createRightBorder(),
    border.createTopBorder(),
    border.createBottomBorder(),
  ]) {
    side.type = LineType2.SOLID
    side.width = LineWidth.MM_0_12
    side.color = '#000000'
  }

  function table(block: TableBlock): void {
    const cols = block.rows[0]!.length
    // Column shares are already canonical (they sum to the scale and clear the
    // minimum share), so scaling to the text width applies no further clamping.
    const widths = distributeWidths(
      CONTENT_WIDTH,
      block.columnWidths ?? Array.from({ length: cols }, () => 1),
    )
    const heights = block.rows.map((row) =>
      Math.max(
        2000,
        ...row.map((cell) =>
          cell.paragraphs.reduce(
            (height, p) =>
              height +
              1800 +
              p.runs.reduce(
                (sum, r) =>
                  sum +
                  (r.kind === 'image'
                    ? Math.min(CONTENT_HEIGHT, r.heightPx * 75)
                    : r.text.split('\n').length * 300),
                0,
              ),
            400,
          ),
        ),
      ),
    )
    const object = TableFromArray.make(
      block.rows.map((row) => row.map(() => '')),
      {
        columnWidths: widths,
        rowHeights: heights,
        borderFillIDRef: border.id!,
        cellSpacing: 0,
        cellPadding: { left: 283, right: 283, top: 141, bottom: 141 },
      },
    )
    placeShape(
      object,
      CONTENT_WIDTH,
      heights.reduce((a, b) => a + b, 0),
      NumberingType.TABLE,
    )
    object.pageBreak = TablePageBreak.CELL
    object.repeatHeader = block.rows[0]!.every((cell) => cell.header)
    object.noAdjust = false
    object.createInMargin().leftAnd(0).rightAnd(0).topAnd(0).bottomAnd(0)
    for (let r = 0; r < object.trList.length; r++)
      for (let c = 0; c < cols; c++) {
        const cell = object.trList[r]!.tcList[c]!
        cell.header = block.rows[r]![c]!.header
        cell.borderFillIDRef = border.id
        cell.hasMargin = true
        cell.protect = false
        cell.editable = true
        cell.dirty = false
        cell.createCellAddr().colAddrAnd(c).rowAddrAnd(r)
        cell.createCellSpan().colSpanAnd(1).rowSpanAnd(1)
        const sub = cell.createSubList()
        sub.id = String(serial++)
        sub.textDirection = TextDirection.HORIZONTAL
        sub.vertAlign = VertAlign.TOP
        sub.textWidth = widths[c]! - 566
        sub.textHeight = heights[r]! - 282
        for (const p of block.rows[r]![c]!.paragraphs)
          sub.addPara(makeParagraph(p, true, Math.max(100, widths[c]! - 566)))
      }
    const wrapper = makeParagraph({
      kind: 'paragraph',
      runs: [],
      align: 'left',
      lineHeight: 160,
      heading: 0,
      indent: 0,
      pre: false,
    })
    wrapper.addNewRun().charPrIDRefAnd('0').addItem(object)
    section.paraListCore.addPara(wrapper)
  }

  for (const block of document.blocks) {
    if (block.kind === 'paragraph') section.paraListCore.addPara(makeParagraph(block))
    else table(block)
  }
  return HWPXWriter.toBytes(doc)
}
