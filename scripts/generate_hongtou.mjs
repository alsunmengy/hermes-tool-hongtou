#!/usr/bin/env node
// hermes-hongtou：Hermes 版红头公文生成器（基于 dsh-tool-hongtou phase2 渲染逻辑改造）。
// 品牌：Hermes 智能体联合委员会；落款 = 部门(组织名) + 签名(本会话参与模型) + 日期。
// 用法：
//   node generate_hongtou.mjs [事由] [--models "模型A、模型B"] [--seal 路径] [--out 目录]
//   [--number 文号] [--title 标题] [--recipient 主送] [--lead 导语] [--closing 结语]
//   [--date YYYY-MM-DD] [--draft draft.json] [--no-mine]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKELETON = join(HERE, "..", "templates", "document-skeleton.xml");
const BODY_MARKER = "<!--HONDTOU:BODY-->";

// ===== 品牌常量 =====
export const HERMES_ORG = "Hermes 智能体联合委员会";
export const HERMES_ORG_OFFICE = `${HERMES_ORG}办公室`;

// ===== 通用工具 =====
export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
export function chineseDate(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
function textWidthUnits(text) {
  return [...String(text ?? "")].reduce((sum, ch) => sum + (/[\u2e80-\uffef]/u.test(ch) ? 1 : 0.5), 0);
}
function artTextWidth(issuer) {
  const width = Math.min(441, Math.max(150, Math.round(textWidthUnits(issuer) * 33.25)));
  const marginLeft = Math.round((441 - width) / 2 + 5.25);
  return { width, marginLeft };
}

// ===== 红头（艺术字 + 双红线）=====
const TEXTPATH_SHAPETYPE = '<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e"><v:formulas><v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/><v:f eqn="sum 0 0 @2"/><v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/><v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/><v:f eqn="if @0 @4 21600"/><v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/><v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/></v:formulas><v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/><v:textpath on="t" fitshape="t"/><v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles><o:lock v:ext="edit" text="t" shapetype="t"/></v:shapetype>';
const RED_LINE_FINE = '<v:line id="_x0000_s2068" style="position:absolute;left:0;text-align:left;flip:y;z-index:2;mso-position-horizontal-relative:text;mso-position-vertical-relative:text" from="5.1pt,60.65pt" to="446.15pt,60.95pt" strokecolor="red" strokeweight="1.5pt"/>';
const RED_LINE_THICK = '<v:line id="_x0000_s2067" style="position:absolute;left:0;text-align:left;z-index:1;mso-position-horizontal-relative:text;mso-position-vertical-relative:text" from="5.25pt,53.2pt" to="446.25pt,53.2pt" strokecolor="red" strokeweight="3pt"/>';

// ===== 公章覆盖层（可选）=====
const SEAL_SHAPETYPE =
  '<v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t" path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f">' +
  '<v:stroke joinstyle="miter"/>' +
  '<v:formulas><v:f eqn="if lineDrawn pixelLineWidth 0"/><v:f eqn="sum @0 1 0"/><v:f eqn="sum 0 0 @1"/><v:f eqn="prod @2 1 2"/><v:f eqn="prod @3 21600 pixelWidth"/><v:f eqn="prod @3 21600 pixelHeight"/><v:f eqn="sum @0 0 1"/><v:f eqn="prod @6 1 2"/><v:f eqn="prod @7 21600 pixelWidth"/><v:f eqn="sum @8 21600 0"/><v:f eqn="prod @7 21600 pixelHeight"/><v:f eqn="sum @10 21600 0"/></v:formulas>' +
  '<v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/><o:lock v:ext="edit" aspectratio="t"/></v:shapetype>';
const SEAL_BIN_NAME = "wordml://hongtou_seal.png";
export const SEAL_GEOMETRY = { sizePt: 112, offsetXPt: 235, offsetYPt: -58, rotation: 0, zIndex: -1 };

function sealParagraph(sealBase64, geometry = {}) {
  const g = { ...SEAL_GEOMETRY, ...geometry };
  const pict =
    `<w:pict><w:binData w:name="${SEAL_BIN_NAME}" xml:space="preserve">${sealBase64}</w:binData>` +
    `<v:shape id="_x0000_s2090" o:spid="_x0000_i1025" type="#_x0000_t75" ` +
    `style="position:absolute;left:0;text-align:left;margin-left:${g.offsetXPt}pt;margin-top:${g.offsetYPt}pt;width:${g.sizePt}pt;height:${g.sizePt}pt;z-index:${g.zIndex};rotation:${g.rotation ?? 0};mso-position-horizontal-relative:text;mso-position-vertical-relative:paragraph" ` +
    `o:allowoverlap="t" filled="f" stroked="f">` +
    `<v:imagedata src="${SEAL_BIN_NAME}" o:title=""/><o:lock v:ext="edit" aspectratio="t"/><w10:wrap type="none"/><w10:anchorlock/>` +
    `</v:shape></w:pict>`;
  return `<w:p><w:pPr><w:snapToGrid w:val="off"/><w:spacing w:line="1" w:line-rule="exact"/></w:pPr><w:r>${pict}</w:r></w:p>`;
}

// ===== 段落渲染 =====
const BODY_RPR = '<w:rPr><w:rFonts w:ascii="仿宋_GB2312" w:fareast="仿宋_GB2312"/><wx:font wx:val="仿宋_GB2312"/><w:sz w:val="32"/></w:rPr>';
function blankLine() {
  return '<w:p><w:pPr><w:snapToGrid w:val="off"/><w:spacing w:line="560" w:line-rule="exact"/><w:ind w:right="654"/><w:jc w:val="left"/>' + BODY_RPR + '</w:pPr></w:p>';
}
function documentNumberParagraph(text) {
  return `<w:p><w:pPr><w:snapToGrid w:val="off"/><w:spacing w:line="560" w:line-rule="exact"/><w:ind w:right="320"/><w:jc w:val="right"/>${BODY_RPR}</w:pPr><w:r>${BODY_RPR}<w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}
function titleParagraph(text) {
  const rPr = '<w:rPr><w:rFonts w:ascii="方正小标宋简体" w:fareast="方正小标宋简体"/><wx:font wx:val="方正小标宋简体"/><w:sz w:val="44"/><w:sz-cs w:val="44"/></w:rPr>';
  return `<w:p><w:pPr><w:snapToGrid w:val="off"/><w:spacing w:line="560" w:line-rule="exact"/><w:ind w:right="654"/><w:jc w:val="center"/>${rPr}</w:pPr><w:r>${rPr}<w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}
function recipientParagraph(text) {
  return `<w:p><w:pPr><w:snapToGrid w:val="off"/><w:spacing w:line="560" w:line-rule="exact"/><w:ind w:right="654"/><w:jc w:val="left"/>${BODY_RPR}</w:pPr><w:r>${BODY_RPR}<w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}
function bodyParagraph(text, fonts = "仿宋_GB2312", options = {}) {
  const bold = options.bold ? "<w:b/>" : "";
  const hAnsi = options.hAnsi ? `<w:rFonts w:ascii="${fonts}" w:h-ansi="${fonts}" w:fareast="${fonts}"/>` : `<w:rFonts w:ascii="${fonts}" w:fareast="${fonts}"/>`;
  const rPr = `<w:rPr>${hAnsi}<wx:font wx:val="${fonts}"/>${bold}<w:sz w:val="32"/></w:rPr>`;
  return `<w:p><w:pPr><w:snapToGrid w:val="off"/><w:spacing w:line="560" w:line-rule="exact"/><w:ind w:right="-81" w:first-line-chars="200" w:first-line="640"/><w:jc w:val="left"/>${rPr}</w:pPr><w:r>${rPr}<w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}
function dateParagraph(dateText) {
  return `<w:p><w:pPr><w:snapToGrid w:val="off"/><w:spacing w:line="560" w:line-rule="exact"/><w:ind w:right="640"/><w:jc w:val="right"/>${BODY_RPR}</w:pPr><w:r>${BODY_RPR}<w:t>${escapeXml(dateText)}</w:t></w:r></w:p>`;
}
// 落款署名段：以成文日期为准居中编排（动态右缩进对齐）。
function signParagraph(text, dateText) {
  const dateUnits = textWidthUnits(dateText);
  const textUnits = textWidthUnits(text);
  const rightIndent = Math.max(320, Math.round(640 + (dateUnits - textUnits) * 16));
  return `<w:p><w:pPr><w:snapToGrid w:val="off"/><w:spacing w:line="560" w:line-rule="exact"/><w:ind w:right="${rightIndent}"/><w:jc w:val="right"/>${BODY_RPR}</w:pPr><w:r>${BODY_RPR}<w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}

// ===== 层次序号 =====
const CN_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function levelMarker(level, index) {
  switch (level) {
    case 0: return `${CN_NUMERALS[index] ?? String(index + 1)}、`;
    case 1: return `（${CN_NUMERALS[index] ?? String(index + 1)}）`;
    case 2: return `${index + 1}. `;
    default: return `（${index + 1}）`;
  }
}
function renderNestedItems(items, level) {
  const out = [];
  (items ?? []).forEach((item, index) => {
    const text = typeof item === "string" ? item : item?.title ?? "";
    if (!text) return;
    const fonts = level === 1 ? "楷体_GB2312" : "仿宋_GB2312";
    const bold = level === 1;
    out.push(bodyParagraph(`${levelMarker(level, index)}${text}`, fonts, { bold }));
    if (typeof item === "object" && Array.isArray(item.items) && item.items.length) {
      out.push(renderNestedItems(item.items, level + 1));
    }
  });
  return out.join("\n");
}
function renderSections(sections) {
  const out = [];
  sections.forEach((section, index) => {
    out.push(bodyParagraph(`${levelMarker(0, index)}${section.title}`, "黑体", { bold: true }));
    for (const paragraphText of section.paragraphs ?? []) out.push(bodyParagraph(paragraphText));
    if (section.items?.length) out.push(renderNestedItems(section.items, 1));
  });
  return out.join("\n");
}

// ===== 附件 =====
function attachmentParagraph(index, name) {
  const label = index === 0 ? "附件：" : "";
  const number = `${index + 1}. `;
  return `<w:p><w:pPr><w:snapToGrid w:val="off"/><w:spacing w:line="560" w:line-rule="exact"/><w:ind w:right="654" w:left="1920" w:hanging="1280"/><w:jc w:val="left"/>${BODY_RPR}</w:pPr><w:r>${BODY_RPR}<w:t>${escapeXml(label)}</w:t></w:r><w:r>${BODY_RPR}<w:t>${escapeXml(number)}</w:t></w:r><w:r>${BODY_RPR}<w:t>${escapeXml(name)}</w:t></w:r></w:p>`;
}
function renderAttachments(attachments) {
  const list = (attachments ?? []).filter(Boolean);
  if (!list.length) return "";
  return `${blankLine()}\n${list.map((name, index) => attachmentParagraph(index, name)).join("\n")}`;
}

// ===== 版记 =====
const RECT_SHAPETYPE = '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>';
const COLOPHON_SPACER = '<v:shape id="_x0000_s2071" type="#_x0000_t202" style="position:absolute;left:1483;top:12706;width:8190;height:567;visibility:visible;mso-position-vertical-relative:page" filled="f" stroked="f"><v:textbox style="mso-next-textbox:#_x0000_s2071" inset="0,0,0,0"><w:txbxContent><w:p><w:pPr><w:pStyle w:val="a4"/><w:rPr><w:rFonts w:ascii="宋体" w:eastAsia="宋体"/></w:rPr></w:pPr></w:p></w:txbxContent></v:textbox></v:shape>';
const COLOPHON_LINE_TOP = '<v:line id="_x0000_s2072" style="position:absolute;mso-position-horizontal-relative:margin;mso-position-vertical-relative:page" from="1483,13330" to="10327,13330"/>';
const COLOPHON_LINE_BOTTOM = '<v:line id="_x0000_s2073" style="position:absolute;mso-position-horizontal-relative:margin;mso-position-vertical-relative:page" from="1483,13954" to="10327,13954"/>';
function colophonOfficeBox(shapeId, office, width) {
  const content = `<w:p><w:pPr><w:pStyle w:val="a4"/><w:wordWrap w:val="off"/><w:ind w:firstLine="320"/><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:hint="eastAsia"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t>${escapeXml(office)}</w:t></w:r></w:p>`;
  return `<v:shape id="_x0000_${shapeId}" type="#_x0000_t202" style="position:absolute;left:1483;top:13330;width:${width};height:567;mso-position-vertical-relative:page" filled="f" stroked="f"><v:textbox style="mso-next-textbox:#_x0000_${shapeId}" inset="0,0,0,0"><w:txbxContent>${content}</w:txbxContent></v:textbox></v:shape>`;
}
function colophonDateBox(shapeId, printed, width) {
  const content = `<w:p><w:pPr><w:wordWrap w:val="off"/><w:ind w:right="320"/><w:jc w:val="right"/><w:rPr><w:rFonts w:ascii="仿宋_GB2312" w:eastAsia="仿宋_GB2312"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="仿宋_GB2312" w:eastAsia="仿宋_GB2312" w:hint="eastAsia"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t>${escapeXml(printed)}</w:t></w:r></w:p>`;
  const left = 10327 - width;
  return `<v:shape id="_x0000_${shapeId}" type="#_x0000_t202" style="position:absolute;left:${left};top:13330;width:${width};height:567;mso-position-vertical-relative:page" filled="f" stroked="f"><v:textbox style="mso-next-textbox:#_x0000_${shapeId}" inset="0,0,0,0"><w:txbxContent>${content}</w:txbxContent></v:textbox></v:shape>`;
}
function renderColophon(draft, date) {
  const office = draft.issuer.endsWith("办公室") ? draft.issuer : `${draft.issuer}办公室`;
  const printed = `${chineseDate(date)}印发`;
  const officeWidth = Math.round(Math.max(2800, textWidthUnits(office) * 280 + 600));
  const dateWidth = Math.round(Math.max(2600, textWidthUnits(printed) * 280 + 600));
  return `<w:p><w:pPr><w:spacing w:line="240" w:line-rule="exact"/><w:jc w:val="left"/></w:pPr><w:r><w:pict><v:group id="_x0000_s2070" style="position:absolute;left:0;text-align:left;margin-left:0;margin-top:668.8pt;width:443.35pt;height:62.4pt;z-index:-1;mso-position-vertical-relative:page" coordorigin="1483,12706" coordsize="8867,1248">${RECT_SHAPETYPE}${COLOPHON_SPACER}${COLOPHON_LINE_TOP}${COLOPHON_LINE_BOTTOM}${colophonOfficeBox("s2074", office, officeWidth)}${colophonDateBox("s2075", printed, dateWidth)}</v:group></w:pict></w:r></w:p>`;
}

function redHeaderParagraph(issuer) {
  const { width, marginLeft } = artTextWidth(issuer);
  const artText = `<w:pict>${TEXTPATH_SHAPETYPE}<v:shape id="_x0000_s2069" type="#_x0000_t136" style="position:absolute;left:0;text-align:left;margin-left:${marginLeft}pt;margin-top:-4.2pt;width:${width}pt;height:51pt;z-index:3;mso-position-horizontal-relative:text;mso-position-vertical-relative:text" fillcolor="red" strokecolor="red"><v:shadow color="#868686"/><v:textpath style="font-family:&quot;华文中宋&quot;;font-weight:bold;v-text-kern:t" trim="t" fitpath="t" string="${escapeXml(issuer)}"/></v:shape></w:pict>`;
  const fine = `<w:pict>${RED_LINE_FINE}</w:pict>`;
  const thick = `<w:pict>${RED_LINE_THICK}</w:pict>`;
  return [
    '<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="方正粗宋简体" w:fareast="方正粗宋简体"/><wx:font wx:val="方正粗宋简体"/><w:b/><w:color w:val="FF0000"/><w:sz w:val="76"/><w:sz-cs w:val="76"/></w:rPr></w:pPr>',
    `<w:r><w:rPr><w:rFonts w:ascii="仿宋_GB2312" w:fareast="仿宋_GB2312"/><wx:font wx:val="仿宋_GB2312"/><w:noProof/><w:sz w:val="32"/></w:rPr>${artText}</w:r>`,
    `<w:r><w:rPr><w:rFonts w:ascii="方正粗宋简体" w:fareast="方正粗宋简体"/><wx:font wx:val="方正粗宋简体"/><w:noProof/><w:sz w:val="76"/><w:sz-cs w:val="76"/></w:rPr>${fine}</w:r>`,
    `<w:r><w:rPr><w:rFonts w:ascii="方正粗宋简体" w:fareast="方正粗宋简体"/><wx:font wx:val="方正粗宋简体"/><w:noProof/><w:sz w:val="76"/><w:sz-cs w:val="76"/></w:rPr>${thick}</w:r>`,
    "</w:p>",
  ].join("");
}

function renderBody(draft, date, sealBase64, geometry) {
  const dateText = chineseDate(date);
  const parts = [];
  parts.push(redHeaderParagraph(draft.issuer));
  parts.push(blankLine());
  parts.push(documentNumberParagraph(draft.documentNumber));
  parts.push(blankLine());
  parts.push(titleParagraph(draft.title));
  parts.push(blankLine());
  parts.push(recipientParagraph(draft.recipient));
  parts.push(bodyParagraph(draft.lead));
  parts.push(renderSections(draft.sections));
  parts.push(bodyParagraph(draft.closing));
  parts.push(renderAttachments(draft.attachments));
  parts.push(blankLine());
  parts.push(blankLine());
  // 落款：部门（组织名）+ 签名（本会话参与模型）+ 日期
  parts.push(signParagraph(draft.issuer, dateText));
  if (draft.signatureModels) parts.push(signParagraph(draft.signatureModels, dateText));
  parts.push(dateParagraph(dateText));
  if (sealBase64) parts.push(sealParagraph(sealBase64, geometry));
  parts.push(renderColophon(draft, date));
  return parts.join("\n");
}

async function loadSkeleton() {
  const template = await readFile(SKELETON, "utf8");
  const dirty = /<(?:w:txbxContent|v:textbox|aml:annotation|w:commentRangeStart|w:comment)\b/iu.test(template);
  if (dirty) throw new Error("模板骨架包含禁止的文本框或批注，拒绝加载");
  if (!template.includes(BODY_MARKER)) throw new Error("模板骨架缺少 body 注入占位符");
  return template;
}

export async function renderDocument(rawDraft, options = {}) {
  const date = options.date instanceof Date ? options.date : new Date();
  const draft = cleanDraftText(rawDraft);
  const safeTitle = escapeXml(String(draft.title ?? "办理情况通报"));
  const safeIssuer = escapeXml(String(draft.issuer ?? HERMES_ORG));
  const template = await loadSkeleton();
  const [head, tail] = template.split(BODY_MARKER);
  const header = head
    .replace("__HONDTOU_TITLE__", safeTitle)
    .replace("__HONDTOU_ISSUER__", safeIssuer)
    .replace("__HONDTOU_CREATED__", date.toISOString());
  let sealBase64 = null;
  if (options.seal) {
    const image = await readFile(options.seal);
    sealBase64 = image.toString("base64");
  }
  return `${header}${renderBody(draft, date, sealBase64, options.sealGeometry)}${tail}`;
}

// ===== Markdown/占位符清洗（对齐上游 schema.js 的净化职责）=====
function stripMarkdown(value) {
  return String(value ?? "")
    .replace(/^#{1,6}\s*/gmu, "")
    .replace(/^>\s*/gmu, "")
    .replace(/^[-*+]\s+/gmu, "")
    .replace(/^\s*\d+[.、)]\s+/gmu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/`+/gu, "")
    .replace(/[*_~]/gu, "")
    .replace(/\|/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
function cleanDraftText(draft) {
  const c = (v) => stripMarkdown(v);
  return {
    ...draft,
    issuer: c(draft?.issuer),
    documentNumber: c(draft?.documentNumber),
    title: c(draft?.title),
    recipient: c(draft?.recipient),
    lead: c(draft?.lead),
    closing: c(draft?.closing),
    signatureModels: c(draft?.signatureModels),
    sections: (draft?.sections ?? []).map((s) => ({
      title: c(s?.title),
      paragraphs: (s?.paragraphs ?? []).map(c),
      items: (s?.items ?? []).map((it) =>
        typeof it === "string" ? c(it) : { title: c(it?.title), items: (it?.items ?? []).map(c) }
      ),
    })),
  };
}

// ===== 生成后校验（与上游一致的关键点）=====
export function validateGeneratedXml(xml) {
  const failures = [];
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"')) failures.push("缺少 UTF-8 XML 声明");
  if (!xml.includes("<w:wordDocument")) failures.push("缺少 Word 2003 XML 根节点");
  if (!xml.includes('<w:pgMar w:top="2098" w:right="1474" w:bottom="1985" w:left="1588"')) failures.push("页边距不符合样板版心");
  if (!/<v:line\b[^>]*strokecolor="red"/iu.test(xml)) failures.push("缺少红色分割线");
  if (!/<v:line\b[^>]*strokeweight="3pt"/iu.test(xml)) failures.push("缺少粗红线（3pt）");
  if (!/<v:line\b[^>]*strokeweight="1.5pt"/iu.test(xml)) failures.push("缺少细红线（1.5pt）");
  if (!/<w:rFonts w:ascii="方正小标宋简体"[^>]*\/><wx:font wx:val="方正小标宋简体"\/><w:sz w:val="44"/u.test(xml)) failures.push("标题不是方正小标宋体 2 号");
  if (!/<w:ind w:right="320"\/><w:jc w:val="right"/u.test(xml)) failures.push("发文字号未居右空一字");
  if (!/<w:ind w:right="640"\/><w:jc w:val="right"/u.test(xml)) failures.push("成文日期未居右空 4 字");
  if (!/<w:instrText>[^<]*PAGE/u.test(xml)) failures.push("缺少自动页码域（PAGE）");
  if (!/from="1483,13330" to="10327,13330"/u.test(xml)) failures.push("缺少版记上横线");
  if (!/from="1483,13954" to="10327,13954"/u.test(xml)) failures.push("缺少版记下横线");
  if (!/_x0000_s2074/u.test(xml) || !/_x0000_s2075/u.test(xml)) failures.push("版记未采用独立文本框形式");
  if (!/印发/u.test(xml)) failures.push("缺少版记印发日期");
  if (/<(?:aml:annotation|w:commentRangeStart|w:comment)\b/iu.test(xml)) failures.push("包含禁止的批注");
  // 文本类检查前先剥离 <w:binData> 二进制块与标签——base64 中可能含 XXXX/其他字符，
  // 不能把图片数据误判为占位符或 Markdown 残留。
  // 使用逐段删除避免大 base64 块导致正则栈溢出。
  let textOnly = xml;
  while (true) {
    const m = /<w:binData\b[^>]*>/.exec(textOnly);
    if (!m) break;
    const start = m.index;
    const endTag = textOnly.indexOf("</w:binData>", start);
    if (endTag === -1) break;
    textOnly = textOnly.slice(0, start) + textOnly.slice(endTag + 12);
  }
  textOnly = textOnly.replace(/<[^>]*>/gu, "");
  if (/(xxxx|×{2,}|（空一行）|（空两格）|（此处|（略）|（下略）)/iu.test(textOnly)) failures.push("包含禁止的占位符或排版动作字符");
  if (/(?:^|\n)#{1,6}\s|`|\]\(/u.test(textOnly)) failures.push("正文残留 Markdown 语法符号");
  if (xml.includes("<!--")) failures.push("最终文档不得包含注释");
  return failures;
}

// ===== CLI =====
function parseArgs(argv) {
  const opts = { positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      opts[key] = argv[++i];
    } else {
      opts.positionals.push(a);
    }
  }
  return opts;
}

function buildDefaultDraft(opts, date) {
  const year = date.getFullYear();
  const issuer = HERMES_ORG;
  const subject = opts.positionals[0] || "本会话事项办理情况";
  const models = (opts.models ?? "DeepSeek-V4-Flash-0731").split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
  const modelList = models.length ? models : ["DeepSeek-V4-Flash-0731"];
  return {
    issuer,
    documentNumber: opts.number ?? `Hermes发〔${year}〕1号`,
    title: opts.title ?? `${issuer}关于${subject}的办理情况通报`,
    recipient: opts.recipient ?? "各受理窗口、各模型实例、相关运维组：",
    lead: opts.lead ?? "现将有关事项办理情况通报如下。",
    sections: [
      { title: "事项起因与背景", paragraphs: ["根据本会话提出的工作要求，相关智能体调度与运行保障工作随即启动。"], items: [] },
      {
        title: "主要调度与模型执行过程",
        paragraphs: ["围绕需求核验、方案实施、工具调度和结果复核等环节开展工作。"],
        items: modelList.map((m) => `${m} 参与本环节执行`),
      },
      { title: "成果与验收结论", paragraphs: ["有关成果已形成，关键要求已纳入验证范围。"], items: [] },
      { title: "后续运行与归档要求", paragraphs: ["请有关责任单元做好运行观察、资料归档和问题闭环。"], items: [] },
    ],
    attachments: opts.attachments ? opts.attachments.split(/[、,，]/) : [],
    closing: opts.closing ?? "请各有关单位结合职责抓好落实，并及时反馈后续运行中发现的问题。",
    signatureModels: modelList.join("、"),
  };
}

// 章选择：default=新章(assets/seal-default.png)、legacy=旧章(assets/seal-legacy.png)、
// off/none/false=不盖章、绝对或相对路径=自定义。
function resolveSealArg(value) {
  if (!value || value === "off" || value === "none" || value === "false" || value === "0") return null;
  if (value === "default" || value === "true" || value === "auto") return join(HERE, "..", "assets", "seal-default.png");
  if (value === "legacy") return join(HERE, "..", "assets", "seal-legacy.png");
  return value.startsWith("/") || value.startsWith("~") ? value : join(process.cwd(), value);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const date = opts.date ? new Date(`${opts.date}T12:00:00+08:00`) : new Date();
  let draft;
  if (opts.draft) {
    draft = JSON.parse(await readFile(opts.draft, "utf8"));
  } else if (opts["no-mine"]) {
    // 显式跳过挖矿，用骨架（用于测试/快速预览）
    draft = buildDefaultDraft(opts, date);
  } else {
    // 没有 --draft 时自动挖矿：调用 mine_session.py 获取当前会话完整事件
    const miner = join(HERE, "mine_session.py");
    const tmpDraft = join(tmpdir(), `hongtou_draft_${Date.now()}.json`);
    try {
      console.error(`⛏ 自动挖矿中…`);
      execSync(`python3 "${miner}" "" "${tmpDraft}"`, { stdio: ["inherit", "pipe", "inherit"], timeout: 30000 });
      draft = JSON.parse(await readFile(tmpDraft, "utf8"));
    } catch (e) {
      console.error(`⚠ 自动挖矿失败（${e.message}），降级为骨架模式`);
      draft = buildDefaultDraft(opts, date);
    }
  }
  const sealPath = opts.seal === undefined ? join(HERE, "..", "assets", "seal-default.png") : resolveSealArg(opts.seal);
  const xml = await renderDocument(draft, { date, seal: sealPath });
  const failures = validateGeneratedXml(xml);
  if (failures.length) {
    console.error("校验未通过：", failures.join("；"));
    process.exit(1);
  }
  const outDir = opts.out ?? join(process.cwd(), "output");
  await mkdir(outDir, { recursive: true });
  const pad = (n) => String(n).padStart(2, "0");
  // 文件名：红头公文_<主要标题>_<年月日>.xml（如 红头公文_关于软件提示说明_2026.06.07.xml）
  const tag = `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
  const titlePart = String(draft.title ?? "通报")
    .replace(/Hermes 智能体联合委员会关于/gu, "")
    .replace(/的办理情况通报$/gu, "")
    .replace(/[\\/:*?"<>|\s]/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 30);
  // 文件名：红头公文_<年月日>_<标题>.xml（日期在前，便于归档）
  const file = join(outDir, `红头公文_${tag}_${titlePart}.xml`);
  await writeFile(file, xml, "utf8");
  console.log(`OK 已生成：${file}`);
  console.log(`发文机关：${draft.issuer}`);
  if (draft.signatureModels) console.log(`落款签名：${draft.signatureModels}`);
  console.log(`成文日期：${chineseDate(date)}`);
  console.log(`盖章：${sealPath ? `已加盖（${sealPath}）` : "未配置"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
