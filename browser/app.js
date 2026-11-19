'use strict';
const $ = id => document.getElementById(id);
let worker, stream, recorder, timer, running = false, ready = false, busy = false, pipWindow = null, generation = 0, pending = null;
let audioContext;
let lastProgress=0, progressTimer;
function setNotice(s){ $('notice').textContent=s; }
function styleCaption(){
  const color=$('color').value, size=Number($('size').value), opacity=Number($('background').value)/100;
  $('jp').style.color=color; $('jp').style.fontSize=size+'px';
  $('sizeValue').textContent=size+' px'; $('backgroundValue').textContent=Math.round(opacity*100)+'%';
  if(pipWindow&&!pipWindow.closed){pipWindow.document.getElementById('caption').style.color=color;pipWindow.document.getElementById('caption').style.fontSize=size+'px';pipWindow.document.body.style.backgroundColor=`rgba(17,31,27,${opacity})`;}
}
for(const id of ['color','size','background']) $(id).addEventListener('input',styleCaption);
styleCaption();
function show(text,source){$('jp').textContent=text;$('original').textContent=source;if(pipWindow&&!pipWindow.closed){pipWindow.document.getElementById('caption').textContent=text;pipWindow.document.getElementById('source').textContent=source;styleCaption();}}
$('load').onclick=()=>{
  if(!window.isSecureContext){setNotice('请通过 HTTPS 或 localhost 打开页面，不能直接打开 HTML 文件。');return;}
  $('load').disabled=true;$('status').textContent='正在加载模型';$('progress').hidden=false;$('progress').removeAttribute('value');lastProgress=Date.now();
  clearInterval(progressTimer);progressTimer=setInterval(()=>{if(!ready&&Date.now()-lastProgress>30000)setNotice('模型文件较大，可能仍在下载或初始化。若长时间没有变化，请检查网络后刷新页面重试。');},10000);
  worker=new Worker('worker.js',{type:'module'});
  worker.onmessage=e=>{const m=e.data;
    if(m.type==='progress'){ lastProgress=Date.now();$('status').textContent=m.text; if(Number.isFinite(m.progress)){ $('progress').max=100;$('progress').value=m.progress;const amount=Number.isFinite(m.loaded)&&Number.isFinite(m.total)?`（${(m.loaded/1048576).toFixed(1)} / ${(m.total/1048576).toFixed(1)} MB）`:'';setNotice(`当前文件：${m.progress.toFixed(1)}% ${amount}。下载完成后仍需初始化模型。`); }else $('progress').removeAttribute('value'); }
    if(m.type==='ready'){ready=true;clearInterval(progressTimer);$('progress').hidden=true;$('status').textContent='模型已就绪 · 翻译设备：'+m.device;$('start').disabled=false;$('speechModel').disabled=true;setNotice('模型已加载，请允许麦克风访问。');}
    if(m.type==='switching'){$('status').textContent=m.text;setNotice('正在重新加载翻译模型，请稍候。');}
    if(m.type==='badTranslation'){busy=false;if(m.generation===generation){$('original').textContent=m.original;setNotice('翻译结果异常，已跳过这段字幕。');}$('queue').textContent=running?'正在聆听':'已停止';if(pending){const next=pending;pending=null;processPart(next.blob,next.id);}}
    if(m.type==='result'){busy=false;$('queue').textContent=running?'正在聆听':'已停止';if(m.device)$('status').textContent=(running?'正在聆听':'已停止')+' · 翻译设备：'+m.device;if(m.generation===generation&&m.translation){show(m.translation,m.original);setNotice(`识别 ${(m.asrMs/1000).toFixed(1)} 秒，翻译 ${(m.translationMs/1000).toFixed(1)} 秒。`);}if(pending){const next=pending;pending=null;processPart(next.blob,next.id);}}
    if(m.type==='error'){busy=false;clearInterval(progressTimer);$('queue').textContent='处理失败';setNotice(m.message+' 请检查网络与模型下载站是否可访问，然后重试。');if(!ready){$('load').disabled=false;$('progress').hidden=true;$('status').textContent='模型加载失败';worker.terminate();worker=null;}else stop();}
  };
  worker.onerror=e=>{busy=false;ready=false;clearInterval(progressTimer);stop();$('load').disabled=false;$('progress').hidden=true;$('status').textContent='模型加载失败';setNotice('模型运行失败：'+e.message+'。请检查网络和浏览器控制台。');};
  worker.postMessage({type:'load',speechModel:$('speechModel').value});
};
async function processPart(blob,id){
  if(!blob.size||id!==generation)return;
  if(busy){pending={blob,id};$('queue').textContent='处理较慢，保留最新一段音频';return;}
  busy=true;$('queue').textContent='正在识别和翻译';
  try{const data=await blob.arrayBuffer();const decoded=await audioContext.decodeAudioData(data);const offline=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000);const source=offline.createBufferSource();source.buffer=decoded;source.connect(offline.destination);source.start();const rendered=await offline.startRendering();const samples=rendered.getChannelData(0);if(id!==generation){busy=false;return;}worker.postMessage({type:'audio',samples,generation:id},[samples.buffer]);}
  catch(e){busy=false;setNotice('音频处理失败：'+e.message);if(pending){const next=pending;pending=null;processPart(next.blob,next.id);}}
}
function recordPart(id){if(!running||id!==generation)return;const mime=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':MediaRecorder.isTypeSupported('audio/mp4')?'audio/mp4':'';const r=recorder=new MediaRecorder(stream,mime?{mimeType:mime}:{}),chunks=[];r.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};r.onstop=()=>{processPart(new Blob(chunks,{type:r.mimeType}),id);if(running&&id===generation)recordPart(id)};r.start();timer=setTimeout(()=>{if(r.state==='recording')r.stop()},1500);}
function stop(){running=false;clearTimeout(timer);if(recorder&&recorder.state==='recording')recorder.stop();if(stream)stream.getTracks().forEach(t=>t.stop());$('start').disabled=!ready;$('stop').disabled=true;$('status').textContent=ready?'已停止':'模型尚未就绪';$('queue').textContent='已停止';}
$('start').onclick=async()=>{try{if(!navigator.mediaDevices||!window.MediaRecorder)throw Error('浏览器不支持录音，或当前页面不是 HTTPS。');stream=await navigator.mediaDevices.getUserMedia({audio:true});audioContext=audioContext||new AudioContext();await audioContext.resume();generation++;running=true;$('start').disabled=true;$('stop').disabled=false;$('status').textContent='正在聆听';setNotice('识别结果可能有延迟。');recordPart(generation);}catch(e){setNotice('无法开始录音：'+e.message);}};
$('stop').onclick=stop;
$('pip').onclick=async()=>{if(!('documentPictureInPicture' in window)){setNotice('当前浏览器不支持悬浮字幕，请尝试新版 Chrome 或 Edge。');return;}try{pipWindow=await documentPictureInPicture.requestWindow({width:640,height:180});const d=pipWindow.document;d.title='Kotoba Live';const style=d.createElement('style');style.textContent='html,body{margin:0;min-height:100%;}body{display:flex;align-items:center;justify-content:center;text-align:center;color:white;font-family:-apple-system,sans-serif}main{padding:12px;overflow-wrap:anywhere}small{display:block;color:#b4c9be;font-size:13px;margin-top:10px}';d.head.appendChild(style);const main=d.createElement('main'),caption=d.createElement('div'),source=d.createElement('small');caption.id='caption';source.id='source';main.append(caption,source);d.body.append(main);show($('jp').textContent,$('original').textContent);}catch(e){setNotice('无法打开悬浮窗：'+e.message);}};
