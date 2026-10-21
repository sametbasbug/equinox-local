import assert from "node:assert/strict";
import test from "node:test";

import {
  extractBrowserPdfText,
  MAX_BROWSER_PDF_BYTES,
  __test,
} from "../../src/browser-pdf-text.js";

function escapePdfText(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function makePdf(pages) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ];
  const fontObject = 3 + pages.length;
  const firstContentObject = fontObject + 1;
  for (let index = 0; index < pages.length; index += 1) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${firstContentObject + index} 0 R >>`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const text of pages) {
    const stream = `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  }

  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets[index + 1] = Buffer.byteLength(output, "latin1");
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, "latin1");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

test("pdfjs extraction is platform-neutral and keeps bounded page text", async () => {
  const result = await extractBrowserPdfText(makePdf(["Equinox PDF Fixture", "Second page"]), {
    maxPages: 3,
    maxChars: 2_000,
  });
  assert.equal(result.parser, "pdfjs-dist");
  assert.equal(result.pageCount, 2);
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[0].text, "Equinox PDF Fixture");
  assert.equal(result.pages[1].text, "Second page");
  assert.equal(result.textChars, "Equinox PDF Fixture".length + "Second page".length);
  assert.equal(result.truncated, false);
});

test("pdfjs extraction enforces page and character bounds", async () => {
  const result = await extractBrowserPdfText(makePdf(["abcdefghij", "second page"]), {
    maxPages: 1,
    maxChars: 6,
    maxPageChars: 5,
  });
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.pages, [{ pageNumber: 1, text: "abcde" }]);
  assert.equal(result.textChars, 5);
  assert.equal(result.truncated, true);
});

test("pdfjs extraction rejects invalid and oversized PDF input before parsing", async () => {
  let calls = 0;
  const getDocumentImpl = () => {
    calls += 1;
    throw new Error("must not run");
  };
  await assert.rejects(
    extractBrowserPdfText(Buffer.from("not a pdf"), { getDocumentImpl }),
    /valid PDF header/u,
  );
  await assert.rejects(
    extractBrowserPdfText(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(MAX_BROWSER_PDF_BYTES)]), { getDocumentImpl }),
    /parsing limit/u,
  );
  assert.equal(calls, 0);
});

test("pdfjs loading task is destroyed on parse failure", async () => {
  let destroyed = 0;
  const getDocumentImpl = () => ({
    promise: Promise.reject(new Error("broken pdf")),
    destroy: async () => { destroyed += 1; },
  });
  await assert.rejects(
    extractBrowserPdfText(Buffer.from("%PDF-1.4\nfixture"), { getDocumentImpl }),
    /broken pdf/u,
  );
  assert.equal(destroyed, 1);
});

test("page text normalization is bounded without executing PDF content", () => {
  assert.deepEqual(__test.boundedPageText([
    { str: "a\u0000b\r\nc", hasEOL: true },
    { str: "def", hasEOL: false },
  ], 7), { text: "ab\nc\nde", truncated: true });
});

test("browser PDF admission rejects non-Buffer, short, bad-signature and oversized content before pdfjs initialization", async () => {
  let initialization = 0;
  const getDocumentImpl = () => { initialization++; throw Error("parser should not initialize"); };
  for (const buffer of [null,undefined,"not a Buffer",new Uint8Array(Buffer.from("%PDF-1.4")),Buffer.alloc(0),Buffer.from("PDF-")]) {
    await assert.rejects(extractBrowserPdfText(buffer,{getDocumentImpl}),/requires a Buffer|parsing limit/u);
  }
  for (const buffer of [Buffer.from("wrong header"),Buffer.concat([Buffer.alloc(1025,32),Buffer.from("%PDF-")])]) {
    await assert.rejects(extractBrowserPdfText(buffer,{getDocumentImpl}),/valid PDF header/u);
  }
  await assert.rejects(
    extractBrowserPdfText(Buffer.from("%PDF-1.4\nfixture"),{maxBytes:5,getDocumentImpl}),
    /parsing limit/u,
  );
  await assert.rejects(
    extractBrowserPdfText(Buffer.concat([Buffer.from("%PDF-"),Buffer.alloc(MAX_BROWSER_PDF_BYTES)]),{maxBytes:Infinity,getDocumentImpl}),
    /parsing limit/u,
  );
  assert.equal(initialization,0);
});

test("browser PDF parser uses only bounded local/no-worker pdfjs flags, applies total and per-page caps, and cleans processed pages", async () => {
  const calls=[];
  const buffer=Buffer.from("%PDF-1.4\nfixture-only");
  const getDocumentImpl=options=>{
    calls.push(["open",{...options,data:Array.from(options.data)}]);
    return {
      promise:Promise.resolve({
        numPages:4,
        getPage:async number=>{
          calls.push(["getPage",number]);
          return {
            getTextContent:async opts=>{
              calls.push(["getTextContent",number,opts]);
              return {items:[{str:"abcdef\r\nghijk",hasEOL:true}]};
            },
            cleanup:()=>calls.push(["cleanup",number]),
          };
        },
      }),
      destroy:async()=>{calls.push(["destroy"]);},
    };
  };
  const result=await extractBrowserPdfText(buffer,{
    maxBytes:64,maxPages:2,maxChars:10,maxPageChars:7,getDocumentImpl,
  });
  assert.deepEqual(result,{
    parser:"pdfjs-dist",
    pageCount:4,
    pages:[{pageNumber:1,text:"abcdef\n"},{pageNumber:2,text:"abc"}],
    truncated:true,
    textChars:10,
  });
  const flags=calls[0][1];
  assert.deepEqual(flags,{
    data:Array.from(new Uint8Array(buffer)),
    disableWorker:true,disableFontFace:true,isEvalSupported:false,
    useSystemFonts:false,verbosity:0,
  });
  assert.deepEqual(calls.slice(1),[
    ["getPage",1],
    ["getTextContent",1,{disableNormalization:false}],
    ["cleanup",1],
    ["getPage",2],
    ["getTextContent",2,{disableNormalization:false}],
    ["cleanup",2],
    ["destroy"],
  ]);
});

test("browser PDF failures for missing pages, corrupt content or cleanup propagate after task destruction", async () => {
  const buffer=Buffer.from("%PDF-1.4\nfixture");
  for (const kind of ["no-document","no-pages","missing-getPage","missing-page","missing-getTextContent","text-failure","page-cleanup-failure"]) {
    const events=[];
    const textFailure=Error("mock damaged text");
    const cleanupFailure=Error("mock page cleanup failed");
    const getDocumentImpl=()=>({
      promise:Promise.resolve(kind==="no-document"?null:
        kind==="no-pages"?{numPages:0,getPage:async()=>null}:
        kind==="missing-getPage"?{numPages:1}:
        {
          numPages:1,
          getPage:async number=>{
            events.push(["getPage",number]);
            return kind==="missing-page"?null:
              kind==="missing-getTextContent"?{}:{
                getTextContent:async()=>{
                  events.push(["text"]);
                  if(kind==="text-failure")throw textFailure;
                  return {items:[{str:"safe"}]};
                },
                cleanup:()=>{
                  events.push(["cleanup"]);
                  if(kind==="page-cleanup-failure")throw cleanupFailure;
                },
              };
          },
        }),
      destroy:async()=>{events.push(["destroy"]);},
    });
    await assert.rejects(
      extractBrowserPdfText(buffer,{getDocumentImpl}),
      e=> kind==="text-failure"?e===textFailure:
        kind==="page-cleanup-failure"?e===cleanupFailure:
        /could not read any pages|could not read page 1/u.test(e.message),
      kind,
    );
    assert.equal(events.filter(([event])=>event==="destroy").length,1,kind);
    if(kind==="text-failure")assert.deepEqual(events,[["getPage",1],["text"],["destroy"]]);
    if(kind==="page-cleanup-failure")assert.deepEqual(events,[["getPage",1],["text"],["cleanup"],["destroy"]]);
  }
});

test("browser PDF skips malformed text items, strips null characters and caps malicious long page text without running it", async () => {
  const textItems=[
    null,{},5,"untrusted",{str:"a\u0000b\r\nc",hasEOL:true},
    {str:"x".repeat(40),hasEOL:true},
    {str:"tail"},
  ];
  assert.deepEqual(__test.boundedPageText(textItems,8),{text:"ab\nc\nxxx",truncated:true});
  assert.deepEqual(__test.boundedPageText(textItems,0),{text:"",truncated:true});
  const events=[];
  const result=await extractBrowserPdfText(Buffer.from("%PDF-1.4\nmock"),{
    maxPages:10,maxChars:8,maxPageChars:8,
    getDocumentImpl:()=>({
      promise:Promise.resolve({
        numPages:2,
        getPage:async number=>{
          events.push(["page",number]);
          return {getTextContent:async()=>({items:textItems}),cleanup:()=>events.push(["cleanup",number])};
        },
      }),
      destroy:async()=>events.push(["destroy"]),
    }),
  });
  assert.deepEqual(result.pages,[{pageNumber:1,text:"ab\nc\nxxx"}]);
  assert.equal(result.truncated,true);
  assert.equal(result.textChars,8);
  assert.deepEqual(events,[["page",1],["cleanup",1],["destroy"]]);
});

test("browser PDF suppresses loading-task destroy failure without hiding the original parse result or error", async () => {
  const buffer=Buffer.from("%PDF-1.4\nfixture");
  for (const outcome of ["success","failed-document"]) {
    let destroyCalls=0;
    const getDocumentImpl=()=>({
      promise:outcome==="success"?Promise.resolve({
        numPages:1,
        getPage:async()=>({getTextContent:async()=>({items:[{str:"retained"}]})}),
      }):Promise.reject(Error("original parse failure")),
      destroy:async()=>{destroyCalls++;throw Error("destroy error must be suppressed");},
    });
    if(outcome==="success"){
      const result=await extractBrowserPdfText(buffer,{getDocumentImpl});
      assert.deepEqual(result.pages,[{pageNumber:1,text:"retained"}]);
      assert.equal(result.truncated,false);
    }else{
      await assert.rejects(extractBrowserPdfText(buffer,{getDocumentImpl}),/original parse failure/u);
    }
    assert.equal(destroyCalls,1);
  }
});
