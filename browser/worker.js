import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
env.allowLocalModels=false;
env.remoteHost='https://hf-mirror.com/';
let speech, translator, translationDevice='CPU';
function progress(label){return p=>{if(p.status==='progress')postMessage({type:'progress',text:label+'：'+(p.file||'模型文件'),progress:p.progress,loaded:p.loaded,total:p.total});else if(p.status==='initiate')postMessage({type:'progress',text:label+'：正在准备 '+(p.file||'' )});};}
function looksInvalid(text,source){const letters=(text.match(/[\p{L}\p{N}]/gu)||[]).length;const japanese=(text.match(/[\u3040-\u30ff\u3400-\u9fff]/g)||[]).length;return !text||text.length>Math.max(80,source.length*8)||letters>0&&japanese/letters<0.35;}
async function translate(text){const output=await translator(text,{src_lang:'zho_Hans',tgt_lang:'jpn_Jpan',max_new_tokens:64});return (output[0]?.translation_text||'').trim();}
self.onmessage=async e=>{const m=e.data;try{
  if(m.type==='load'){
    speech=await pipeline('automatic-speech-recognition',m.speechModel==='base'?'onnx-community/whisper-base':'onnx-community/whisper-tiny',{dtype:'q8',device:'wasm',progress_callback:progress('正在加载语音模型')});
    postMessage({type:'progress',text:'语音模型已加载，正在准备翻译模型'});
    let device='CPU';
    if(navigator.gpu){try{const adapter=await navigator.gpu.requestAdapter();if(adapter){postMessage({type:'progress',text:'正在尝试 GPU 加速翻译'});translator=await pipeline('translation','Xenova/nllb-200-distilled-600M',{dtype:'q8',device:'webgpu',progress_callback:progress('正在加载翻译模型')});device='GPU';}}catch(error){postMessage({type:'progress',text:'GPU 不可用，正在切换到 CPU'});}}
    if(!translator)translator=await pipeline('translation','Xenova/nllb-200-distilled-600M',{dtype:'q8',device:'wasm',progress_callback:progress('正在加载翻译模型')});
    translationDevice=device;postMessage({type:'ready',device});return;
  }
  if(m.type==='audio'){
    const start=performance.now();const result=await speech(m.samples,{language:'chinese',task:'transcribe',return_timestamps:false});const original=(result.text||'').trim();const asrMs=performance.now()-start;
    if(!original){postMessage({type:'result',original:'',translation:'',generation:m.generation,asrMs,translationMs:0});return;}
    const translationStart=performance.now();let translated=await translate(original);
    if(looksInvalid(translated,original)&&translationDevice==='GPU'){
      postMessage({type:'switching',text:'GPU 输出异常，正在切换到 CPU 重试'});
      await translator.dispose();translator=null;
      translator=await pipeline('translation','Xenova/nllb-200-distilled-600M',{dtype:'q8',device:'wasm',progress_callback:progress('正在加载 CPU 翻译模型')});
      translationDevice='CPU';translated=await translate(original);
    }
    if(looksInvalid(translated,original)){postMessage({type:'badTranslation',original,generation:m.generation});return;}
    postMessage({type:'result',original,translation:translated,generation:m.generation,device:translationDevice,asrMs,translationMs:performance.now()-translationStart});
  }
}catch(err){postMessage({type:'error',message:'模型处理失败：'+(err?.message||String(err))});}};
