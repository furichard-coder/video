import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BgmService } from "../src/main/services/bgm-service";
import { MediaProbe } from "../src/main/services/media-probe";
import { ProjectStore } from "../src/main/services/project-store";
import { runProcess } from "../src/main/services/process-runner";

let root:string; let store:ProjectStore; let mp3Path:string;
const hash=async(filePath:string)=>createHash("sha256").update(await readFile(filePath)).digest("hex");
beforeAll(async()=>{root=await mkdtemp(path.join(os.tmpdir(),"bgm-service-"));store=new ProjectStore(path.join(root,"app-data"));await store.initialize();mp3Path=path.join(root,"使用者 配樂.mp3");await runProcess("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=523:sample_rate=48000","-t","1","-c:a","libmp3lame","-q:a","4","-y",mp3Path]);});
afterAll(async()=>rm(root,{recursive:true,force:true}));
describe("BGM read-only import",()=>{
  it("imports MP3 metadata and 35% default mix settings without changing bytes",async()=>{const before=await hash(mp3Path);const result=await new BgmService(store,new MediaProbe()).importSelected([mp3Path]);expect(result.addedCount).toBe(1);expect(result.project.bgmTracks[0]).toMatchObject({fileName:"使用者 配樂.mp3",sourcePolicy:"READ_ONLY",volumePercent:35,sourceInMs:0,timelineInMs:0,resolutionStatus:"READY"});expect(result.project.bgmTracks[0].durationMs).toBeGreaterThan(900);expect(await hash(mp3Path)).toBe(before);});
  it("rejects non-MP3 selections without touching the manifest",async()=>{const wav=path.join(root,"not-supported.wav");await writeFile(wav,"fixture");const before=store.getProject().bgmTracks.length;const result=await new BgmService(store,new MediaProbe()).importSelected([wav]);expect(result.addedCount).toBe(0);expect(result.errors.join(" ")).toMatch(/只支援 MP3/);expect(store.getProject().bgmTracks).toHaveLength(before);});
  it("keeps YouTube URLs as unresolved rights references and only links a confirmed local MP3",async()=>{const service=new BgmService(store,new MediaProbe());const before=await hash(mp3Path);const queued=await service.addYoutubeReferences(["https://youtu.be/abc123XYZ","https://example.com/not-youtube"]);expect(queued.addedCount).toBe(1);expect(queued.errors.join(" ")).toMatch(/只接受 HTTPS YouTube/);const pending=queued.project.bgmTracks.find((track)=>track.sourceUrl);expect(pending).toMatchObject({sourcePath:"",resolutionStatus:"NEEDS_LOCAL_FILE",volumePercent:35});await expect(service.resolveReference(pending!.id,mp3Path,false)).rejects.toThrow(/確認/);const resolved=await service.resolveReference(pending!.id,mp3Path,true);expect(resolved.project.bgmTracks.find((track)=>track.id===pending!.id)).toMatchObject({sourcePath:mp3Path,resolutionStatus:"READY",rightsConfirmed:true,volumePercent:35});expect(await hash(mp3Path)).toBe(before);});
});
