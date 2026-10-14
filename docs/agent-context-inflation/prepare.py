import pathlib,re,hashlib,json,sys,tempfile,shutil
script_dir=pathlib.Path(__file__).resolve().parent
candidates=[script_dir,*script_dir.parents,pathlib.Path.cwd(),*pathlib.Path.cwd().parents]
repo=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else next((p for p in candidates if (p/'server/agents/providers/engine.ts').is_file()),None)
if repo is None:raise SystemExit('Cannot locate tsEpistle checkout; pass its root as argument1')
root=pathlib.Path(sys.argv[2]).resolve() if len(sys.argv)>2 else pathlib.Path(tempfile.mkdtemp(prefix='falcon-context-probe-')).resolve()
if not root.is_relative_to(pathlib.Path(tempfile.gettempdir()).resolve()):raise SystemExit('Generated probe directory must be inside the system temporary directory')
root.mkdir(parents=True,exist_ok=True);root.chmod(0o700)
if (script_dir/'probe.ts').resolve()!=(root/'probe.ts').resolve():shutil.copyfile(script_dir/'probe.ts',root/'probe.ts')
source=repo/'server/agents/providers/engine.ts';text=source.read_text()
# Keep the extraction confined to the actual production construction, before admission.
# The engine preflight reuses this block; do not copy its diagnostics or dispatch code.
turn_start=text.index('  async #synthesisTurn(')
turn_end=text.find('\n  async #',turn_start+1)
if turn_end<0:turn_end=len(text)
start=text.index('    const sourceEvidence = new Map<string, CitationEvidence>()',turn_start,turn_end)
end=text.index('    let rejection: string | undefined',start,turn_end)
block=text[start:end]
rewritten=re.sub(r"(from\s+['\"])(\.[^'\"]+)(['\"])",lambda m:m[1]+str((source.parent/m[2]).resolve())+m[3],text)
# Bare imports resolve against the installed project packages through the temp symlink.
(root/'node_modules').symlink_to(repo/'node_modules') if not (root/'node_modules').exists() else None
rewritten+='\nexport { parseSourceDocument, projectedSourceUnits, collectPageEvidence, sourceSections, prompt, serializedProviderRequestBytes };\n'
rewritten+='\nexport const probeBuildSynthesisSources=(evidence: ReadonlyMap<string,CitationEvidence>,input:{readonly userRequest:string;readonly requestFacets:readonly string[]})=>{\n'+block+'return {sources,sourceReads};\n};\n'
page_reads=(repo/'server/agents/actions/page-reads.ts').read_text()
a=page_reads.index('const tocSections =');b=page_reads.index('const parsePage =',a)
rewritten+='\n'+page_reads[a:b].replace('const pageCitation =','const productionPageCitation =')+'\nexport {productionPageCitation};\n'
(root/'engine-probe.ts').write_text(rewritten)
(root/'extraction.json').write_text(json.dumps({'repoAbsolutePath':str(repo),'source':'server/agents/providers/engine.ts','sha256':hashlib.sha256(text.encode()).hexdigest(),'sourceBuildingStartLine':text.count('\n',0,start)+1,'sourceBuildingEndLine':text.count('\n',0,end)+1,'rewrites':'relative static imports made absolute; appended helper exports; exact source-building block copied without semantic edits'},indent=2))

print(root)
