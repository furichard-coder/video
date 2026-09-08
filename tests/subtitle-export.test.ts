import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportSrt, serializeSrt } from "../src/main/services/subtitle-export";
import { importSrtFile, parseSrt } from "../src/main/services/subtitle-import";

const roots:string[]=[];
afterEach(async()=>Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true}))));
describe("UTF-8 SRT export",()=>{
  it("uses continuous numbering and standard millisecond timestamps",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"srt-測試-"));roots.push(root);const output=path.join(root,"繁中 字幕.srt");const cues=[{id:"a",startMs:1234,endMs:2567,text:"河內\n街景"},{id:"b",startMs:3_600_000,endMs:3_601_000,text:"第二段"}];expect(serializeSrt(cues)).toContain("00:00:01,234 --> 00:00:02,567");expect(serializeSrt(cues)).toContain("01:00:00,000 --> 01:00:01,000");await writeFile(output,"old");await exportSrt(cues,output);const bytes=await readFile(output);expect(bytes.toString("utf8")).toContain("河內\r\n街景");expect(bytes[0]).not.toBe(0xff);expect((await readdir(root)).filter(name=>name.includes("partial")||name.includes("replaced"))).toEqual([]);});
  it("leaves no partial when cancelled",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"srt-cancel-"));roots.push(root);const controller=new AbortController();controller.abort();await expect(exportSrt([{id:"a",startMs:0,endMs:1000,text:"字幕"}],path.join(root,"cancel.srt"),controller.signal)).rejects.toMatchObject({name:"AbortError"});expect(await readdir(root)).toEqual([]);});
  it("imports UTF-8 BOM, multiline text and dot/comma milliseconds as editable cues",async()=>{let id=0;const cues=parseSrt("\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\n森林養護\r\n減少土壤流失\r\n\r\n2\r\n00:00:04.000 --> 00:00:06.125\r\n第二段",()=>`import-${++id}`);expect(cues).toEqual([expect.objectContaining({id:"import-1",startMs:1250,endMs:3500,text:"森林養護\n減少土壤流失",timelineScope:"MAIN",origin:"IMPORTED_SRT",reviewStatus:"CONFIRMED"}),expect.objectContaining({id:"import-2",startMs:4000,endMs:6125,text:"第二段",timelineScope:"MAIN",origin:"IMPORTED_SRT",reviewStatus:"CONFIRMED"})]);});
  it("reads an SRT through a Unicode path without modifying the source",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"srt-import-繁中-"));roots.push(root);const input=path.join(root,"河內 字幕.srt");const original="1\n00:00:00,000 --> 00:00:02,000\n河內街景\n";await writeFile(input,original,"utf8");const result=await importSrtFile(input);expect(result.fileName).toBe("河內 字幕.srt");expect(result.cues[0]).toMatchObject({startMs:0,endMs:2000,text:"河內街景",origin:"IMPORTED_SRT"});expect(await readFile(input,"utf8")).toBe(original);});
  it("rejects malformed or overlapping SRT without returning partial cues",()=>{expect(()=>parseSrt("1\nnot-a-time\n字幕")).toThrow(/缺少時間範圍/);expect(()=>parseSrt("1\n00:00:00,000 --> 00:00:02,000\n一\n\n2\n00:00:01,000 --> 00:00:03,000\n二")).toThrow(/不可重疊/);});
});
