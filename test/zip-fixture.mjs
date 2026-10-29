/**
 * 测试用 ZIP 构造函数（stored，不压缩）。
 *
 * 为什么要自己造：本插件的 docx/pptx/xlsx 解析走的是零依赖 ZIP 读取器，
 * 它必须能被测试**独立验证**，不能依赖仓库里塞一份二进制样本文件（不可读、不可审）。
 * 这里只实现 "stored" 一种方式 —— 足够喂给解析器，也足够抓出 READER 的结构性错误
 * （中央目录偏移、本地头长度、条目名解析）。deflate 分支由真实文件在人工验证里覆盖。
 */

/** 把一组 {name, data} 打成 ZIP Buffer。 */
export function storedZip(files) {
  const parts = []
  const central = []
  let offset = 0

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8')
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)   // 本地文件头签名
    local.writeUInt16LE(20, 4)           // 解压所需版本
    local.writeUInt16LE(0, 6)            // 通用标志
    local.writeUInt16LE(0, 8)            // 压缩方式 = stored
    local.writeUInt16LE(0, 10)           // 修改时间
    local.writeUInt16LE(0, 12)           // 修改日期
    local.writeUInt32LE(0, 14)           // CRC（解析器不校验）
    local.writeUInt32LE(data.length, 18) // 压缩后大小
    local.writeUInt32LE(data.length, 22) // 未压缩大小
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    const record = Buffer.concat([local, nameBuf, data])
    parts.push(record)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)   // 中央目录签名
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0, 8)
    entry.writeUInt16LE(0, 10)           // 压缩方式 = stored
    entry.writeUInt16LE(0, 12)
    entry.writeUInt16LE(0, 14)
    entry.writeUInt32LE(0, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBuf.length, 28)
    entry.writeUInt16LE(0, 30)
    entry.writeUInt16LE(0, 32)
    entry.writeUInt16LE(0, 34)
    entry.writeUInt16LE(0, 36)
    entry.writeUInt32LE(0, 38)
    entry.writeUInt32LE(offset, 42)      // 本地文件头偏移
    central.push(Buffer.concat([entry, nameBuf]))

    offset += record.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...parts, centralBuf, eocd])
}

/** 造一个最小可解析的 .docx。 */
export function makeDocx(paragraphs) {
  const body = paragraphs
    .map(text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
    .join('')
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}</w:body></w:document>`
  return storedZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: document },
  ])
}

/** 造一个最小可解析的 .pptx（带一个备注页，用于覆盖"备注未纳入分析"的警告路径）。 */
export function makePptx(slides) {
  const files = [{ name: '[Content_Types].xml', data: '<Types/>' }]
  slides.forEach((lines, index) => {
    const body = lines.map(text => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join('')
    files.push({
      name: `ppt/slides/slide${index + 1}.xml`,
      data: '<?xml version="1.0" encoding="UTF-8"?>'
        + '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>'
        + `<a:t>占位</a:t>${body}`
        + '</p:spTree></p:cSld></p:sld>',
    })
  })
  // 备注页：解析器不读它，但必须**报出"有备注、未纳入"**，否则用户会以为备注也参与评分了
  files.push({
    name: 'ppt/notesSlides/notesSlide1.xml',
    data: '<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:p="p"><a:t>演讲者备注</a:t></p:notes>',
  })
  return storedZip(files)
}

/** 造一个最小可解析的 .xlsx。 */
export function makeXlsx(rows) {
  const shared = rows.flat().map(value => `<si><t>${value}</t></si>`).join('')
  let cursor = 0
  const sheetRows = rows.map(row => {
    const cells = row.map(() => `<c t="s"><v>${cursor++}</v></c>`).join('')
    return `<row>${cells}</row>`
  }).join('')
  return storedZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/sharedStrings.xml', data: `<sst>${shared}</sst>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>` },
  ])
}

/** 造一个最小可解析的 .odt（OpenDocument 文字）。 */
export function makeOdt(paragraphs) {
  const body = paragraphs.map(text => `<text:p>${text}</text:p>`).join('')
  return storedZip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' },
    { name: 'content.xml', data: '<?xml version="1.0" encoding="UTF-8"?>'
      + `<office:document-content><office:body><office:text>${body}</office:text></office:body></office:document-content>` },
  ])
}

/**
 * 造一个最小 OLE2（CFB）复合文档 —— 只有目录，没有真实流内容。
 *
 * 用途：验证"扩展名是 .docx，内容其实是 OLE2"这类**真实世界最常见的失败**能被
 * 准确区分成「旧版 .doc」还是「设了打开密码的 docx」。两者对用户是完全不同的动作，
 * 以前它们只有一个统一的报错：未找到中央目录。
 */
export function makeOle2(streamNames) {
  const HEADER = 512
  const SECTOR = 512
  const buf = Buffer.alloc(HEADER + SECTOR * 3)

  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buf, 0)
  buf.writeUInt16LE(0x003e, 0x18)      // minor version
  buf.writeUInt16LE(0x0003, 0x1a)      // major version
  buf.writeUInt16LE(0xfffe, 0x1c)      // byte order
  buf.writeUInt16LE(9, 0x1e)           // sector shift → 512 字节扇区
  buf.writeUInt16LE(6, 0x20)           // mini sector shift
  buf.writeUInt32LE(1, 0x2c)           // FAT 扇区数
  buf.writeUInt32LE(1, 0x30)           // 目录首扇区 = 1
  buf.writeUInt32LE(0xfffffffe, 0x3c)  // mini FAT 首扇区
  buf.writeUInt32LE(0xfffffffe, 0x44)  // DIFAT 首扇区
  buf.writeUInt32LE(0, 0x4c)           // DIFAT[0] = FAT 在扇区 0
  for (let index = 1; index < 109; index += 1) buf.writeUInt32LE(0xffffffff, 0x4c + index * 4)

  const sectorAt = sector => (sector + 1) * SECTOR

  // FAT：扇区 0 是 FAT 自己，扇区 1（目录）是链尾
  buf.writeUInt32LE(0xfffffffd, sectorAt(0))
  buf.writeUInt32LE(0xfffffffe, sectorAt(0) + 4)

  // 目录扇区：每项 128 字节
  streamNames.forEach((name, index) => {
    const at = sectorAt(1) + index * 128
    const encoded = Buffer.from(name, 'utf16le')
    encoded.copy(buf, at)
    buf.writeUInt16LE(encoded.length + 2, at + 0x40)  // 名字长度（含结尾 NUL）
    buf[at + 0x42] = 2                                 // 类型 2 = 流
    buf.writeUInt32LE(0xffffffff, at + 0x74)           // 起始扇区
    buf.writeUInt32LE(0, at + 0x78)                    // 大小
  })

  return buf
}
