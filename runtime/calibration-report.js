// SPDX-License-Identifier: GPL-3.0-or-later

/* Both human-readable exports consume this same completed calibration snapshot.
 * The browser export uses native editable PowerPoint text, shapes and tables. */
import {localeFormats} from './locale.js';
const fmt=(n,d=3)=>Number(n).toFixed(d),base=new URL('./',import.meta.url);
const rows=(data,manifest,t,formats)=>({
 metrics:[
  [t('fitResidual'),formats.number(data.fit[3]*data.camera.unitMm,3)+' mm'],
  [t('boardRmse'),formats.number(data.boardMetrics.reprojectionRmse,3)+' px'],
  [t('boardSpan'),formats.percent(data.boardMetrics.minSpan)],
  [t('boardCorners'),String(data.boardMetrics.minCorners)],
 ],
 settings:[
  [t('cornerRefinement'),t(data.config.cornerRefinement==='subpixel'?'cornerSubpixel':'cornerOff')],
  [t('estimator'),t(['quadratic','centroid','pixel','ridge'][data.config.estimator])],
  [t('threshold'),String(data.config.threshold)],
  ['ChArUco',manifest.board.squares.join(' × ')+' / '+manifest.board.dictionary],
  [t('calibrationFrames'),String(data.calibrationFrames)],
  ['fx / fy',formats.number(data.camera.fx,1)+' / '+formats.number(data.camera.fy,1)+' px'],
  ['cx / cy',formats.number(data.camera.cx,1)+' / '+formats.number(data.camera.cy,1)+' px'],
  [t('distortionModel'),(data.camera.dist&&data.camera.dist.length?((data.camera.model==='none'?t('distNone'):data.camera.model==='rational'?t('distRational'):t('distBrown'))+' · '+data.camera.dist.map(n=>fmt(n,6)).join(', ')):'—')],
 ],
});
const table=items=>['| | |','| :--- | ---: |',...items.map(r=>'| '+r.map(x=>String(x).replaceAll('|','\\|')).join(' | ')+' |')].join('\n');
export function calibrationMarkdown(data,manifest,t,locale='en'){
 const formats=localeFormats(locale),r=rows(data,manifest,t,formats),planes=Object.entries(data.planeFits),created=data.completedAt||new Date().toISOString();
 return `# NIDVUE / ${t('reportTitle')}\n\n**${t(data.dataset+'Name')}**\n\n${created}  \n${data.dataset} / v${data.version} / ${data.camera.width} × ${data.camera.height}\n\n> ${t('synthetic')}.\n\n## 01 / ${t('reportMetrics')}\n\n${table(r.metrics)}\n\n${t('reportInliers')}: **${formats.number(Math.round(data.fit[4]))} / ${formats.number(Math.round(data.fit[5]))}**\n\n## 02 / ${t('reportAcquisition')}\n\n${table(r.settings)}\n\n${t('method')}\n\n## 03 / ${t('params')}\n\n\`Y + nx X + nz Z = d\`\n\n${t('reportCoordinates')}\n\n${data.encoderModel?'```json\n'+JSON.stringify({...data.encoderModel,emitter:undefined,emitterMm:data.encoderModel.emitter.map(v=>v*data.camera.unitMm)},null,2)+'\n```\n\n':''}<details>\n<summary>${t('reportPlaneTable')} (${planes.length})</summary>\n\n| ${t('reportCommand')} | nx | nz | d (mm) | RMS (mm) | ${t('reportInliers')} |\n| ---: | ---: | ---: | ---: | ---: | ---: |\n${planes.map(([key,p])=>`| ${key} | ${fmt(p[0],7)} | ${fmt(p[1],7)} | ${fmt(p[2]*data.camera.unitMm,5)} | ${fmt(p[3]*data.camera.unitMm,5)} | ${Math.round(p[4])} |`).join('\n')}\n\n</details>\n\n## 04 / ${t('reportNext')}\n\n${t('validationUsesFit')} ${t('validationIntro')}\n\n${t('honesty')}\n\n---\n\nNIDVUE · ${t('title')}\n`;
}
async function dataUri(url){const r=await fetch(url);if(!r.ok)throw new Error('reportFailed');return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;r.blob().then(b=>reader.readAsDataURL(b),reject);});}
export async function calibrationPowerpoint(data,manifest,t,locale){
 const {default:PptxGenJS}=await import('./vendor/pptxgen.js'),pptx=new PptxGenJS();
 pptx.layout='LAYOUT_WIDE';pptx.author='NIDVUE';pptx.subject=t('title');pptx.title=t('reportTitle');pptx.company='NIDVUE';pptx.lang=locale;pptx.theme={headFontFace:locale==='zh'?'Noto Sans SC':locale==='ja'?'Noto Sans CJK JP':'Inter',bodyFontFace:locale==='zh'?'Noto Sans SC':locale==='ja'?'Noto Sans CJK JP':'Inter',lang:locale};
 const logo=await dataUri(new URL('brand/nidvue-lockup-inverse.svg',base));
 const C={bg:'0A0E1D',ink:'F5F6FF',muted:'B3BAD0',line:'28314A',accent:'A09FFF',brand:'5857E8',surface:'141A2D'},font=pptx.theme.bodyFontFace;
 const text=(s,value,x,y,w,h,size=18,extra={})=>s.addText(String(value),{x,y,w,h,fontFace:font,fontSize:size,color:C.ink,margin:0,breakLine:false,valign:'mid',...extra});
 const rect=(s,x,y,w,h,color)=>s.addShape(pptx.ShapeType.rect,{x,y,w,h,line:{color,width:0},fill:{color}});
 const newSlide=(title,index)=>{const s=pptx.addSlide();s.background={color:C.bg};s.addImage({data:logo,x:.65,y:.29,w:1.65,h:1.65*70/281});text(s,title,.65,.98,12,1,30,{bold:true});rect(s,.65,6.94,12.03,.008,C.line);text(s,t('synthetic'),.65,7.08,11,.18,9,{color:C.muted});text(s,String(index).padStart(2,'0'),12.1,7.06,.55,.22,10,{fontFace:'JetBrains Mono',align:'right',color:C.muted});return s;};
 const formats=localeFormats(locale),{metrics,settings}=rows(data,manifest,t,formats);
 const photo=await dataUri(new URL(`../demo/calibration/${data.dataset}/${manifest.calibration[Math.floor(manifest.calibration.length/2)].file}`,base));
 const s1=newSlide(t('reportTitle'),1);
 text(s1,t(data.dataset+'Name').replace(' · ','\n'),.65,2.22,5.05,1.1,27,{bold:true});
 text(s1,`${t('calibrationFrames')}: ${data.calibrationFrames}\n${data.camera.width} × ${data.camera.height}\nv${data.version}`, .65,4.76,5.05,1.1,16,{fontFace:'JetBrains Mono',color:C.muted,breakLine:false});
 s1.addImage({data:photo,x:6.05,y:2.3,w:6.63,h:6.63*9/16});text(s1,(data.completedAt||new Date().toISOString()).replace('T',' ').slice(0,19)+' UTC',6.05,6.20,6.63,.25,10,{fontFace:'JetBrains Mono',color:C.muted});s1.addNotes(t('honesty'));
 const s2=newSlide(t('reportMetrics'),2);
 metrics.forEach(([label,value],i)=>{const x=.65+(i%2)*6.16,y=2.22+Math.floor(i/2)*1.66;rect(s2,x,y,5.87,1.42,C.surface);text(s2,label,x+.24,y+.16,5.36,.38,15,{color:C.muted});text(s2,value,x+.24,y+.66,5.36,.55,31,{fontFace:'JetBrains Mono',color:C.accent});});
 text(s2,`${t('reportInliers')}: ${formats.number(Math.round(data.fit[4]))} / ${formats.number(Math.round(data.fit[5]))}`,.65,5.92,12,.44,16,{fontFace:'JetBrains Mono'});s2.addNotes(t('metricsHelp'));
 const s3=newSlide(t('reportAcquisition'),3);
 const tableStyle={x:.65,y:2.2,w:12.03,colW:[4.2,7.83],rowH:.48,fontFace:font,fontSize:15,color:C.ink,fill:C.surface,border:{type:'solid',color:C.line,pt:.6},margin:[8,12,8,12],autoPage:false,verbose:false};
 s3.addTable(settings.map(([a,b])=>[{text:a,options:{color:C.muted}},{text:b,options:{fontFace:/^[\d.]/.test(b)?'JetBrains Mono':font}}]),tableStyle);s3.addNotes(t('method'));
 const s4=newSlide(t('params'),4);
 text(s4,'Y + nx X + nz Z = d',.65,2.18,12,.58,28,{fontFace:'JetBrains Mono',color:C.accent});text(s4,t('reportCoordinates'),.65,2.99,12,.70,16,{color:C.muted});
 if(data.encoderModel){
  const model=data.encoderModel;
  text(s4,'[nx, nz] = b0 + b1 qx + b2 qy',.65,3.94,12,.45,20,{fontFace:'JetBrains Mono'});
  const coefficients=[model.nx,model.nz];
  s4.addTable([['','b0','b1','b2'],...coefficients.map((row,i)=>[i?'nz':'nx',...row.map(n=>fmt(n,7))])],{...tableStyle,y:4.65,colW:[1.8,3.41,3.41,3.41],fontFace:'JetBrains Mono',rowH:.49});
  text(s4,'E [X,Y,Z] (mm) = '+model.emitter.map(n=>fmt(n*data.camera.unitMm,1)).join(', '),.65,6.34,12,.3,14,{fontFace:'JetBrains Mono',color:C.muted});
 }else{
  const p=Object.values(data.planeFits)[0];s4.addTable([['nx','nz','d (mm)'],[fmt(p[0],7),fmt(p[1],7),fmt(p[2]*data.camera.unitMm,5)]],{...tableStyle,y:4.13,colW:[4.01,4.01,4.01],fontFace:'JetBrains Mono',rowH:.7});
 }
 s4.addNotes(JSON.stringify({planeFits:data.planeFits,encoderModel:data.encoderModel,config:data.config},null,2));
 const s5=newSlide(t('reportNext'),5);text(s5,t('validationUsesFit'),.65,2.26,11.8,1.2,23,{bold:true});text(s5,t('validationIntro'),.65,3.68,11.8,.8,20,{color:C.muted});text(s5,t('honesty'),.65,4.97,11.8,1.35,14,{color:C.muted});
 return pptx.write({outputType:'blob',compression:true});
}
