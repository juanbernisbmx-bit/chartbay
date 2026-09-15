var L=Object.defineProperty;var N=(u,o,p)=>o in u?L(u,o,{enumerable:!0,configurable:!0,writable:!0,value:p}):u[o]=p;var E=(u,o,p)=>N(u,typeof o!="symbol"?o+"":o,p);(function(){"use strict";class l extends Error{constructor(t,e){super(e),this.code=t,this.name="ChartPythonKernelError"}}const P=String.raw`
import contextlib, io, json, traceback, warnings, linecache, re, base64, builtins
from pyodide.code import eval_code_async
with warnings.catch_warnings():
    warnings.filterwarnings('ignore', category=DeprecationWarning, message='.*Pyarrow.*')
    import pandas as pd
import os
os.chdir('/mnt/data')

class Stream(io.TextIOBase):
    def __init__(self, name, emit):
        self.name, self.emit = name, emit
    def writable(self):
        return True
    def write(self, text):
        if text:
            self.emit(json.dumps({'output_type': 'stream', 'name': self.name, 'text': text[:1048577]}, ensure_ascii=True))
        return len(text)
    def flush(self):
        pass

def plain(text):
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)

def bundle(value):
    data = {'text/plain': repr(value)[:262144]}
    html = getattr(value, '_repr_html_', None)
    if callable(html):
        try:
            rendered = html()
            if isinstance(rendered, str):
                data['text/html'] = rendered[:262144]
        except Exception:
            pass
    for mime, method in [('image/png', '_repr_png_'), ('image/svg+xml', '_repr_svg_')]:
        render = getattr(value, method, None)
        if callable(render):
            try:
                result = render()
                if mime == 'image/png' and isinstance(result, bytes):
                    result = base64.b64encode(result).decode('ascii')
                if isinstance(result, str) and len(result) <= 524288:
                    data[mime] = result
            except Exception:
                pass
    return data

def no_input(*args, **kwargs):
    raise RuntimeError('input() no está disponible en ChartPython. Asigná el valor en una celda o cargá un archivo.')

active_emit = None

def display(*values):
    if active_emit is not None:
        for value in values:
            active_emit(json.dumps({'output_type': 'display_data', 'data': bundle(value), 'metadata': {}}, ensure_ascii=True))

async def execute(code, count, emit):
    global active_emit
    active_emit = emit
    # Restore the display helper between executions; user variables persist.
    user['display'] = display
    filename = '<ChartPython cell %s>' % count
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
    # Tracebacks for recent cells remain useful without keeping every edit forever.
    if count > 100:
        linecache.cache.pop('<ChartPython cell %s>' % (count - 100), None)
    with contextlib.redirect_stdout(Stream('stdout', emit)), contextlib.redirect_stderr(Stream('stderr', emit)):
        try:
            value = await eval_code_async(code, globals=user, filename=filename)
            if value is not None:
                user['___'], user['__'], user['_'] = user.get('__'), user.get('_'), value
                emit(json.dumps({'output_type': 'execute_result', 'execution_count': count, 'data': bundle(value), 'metadata': {}}, ensure_ascii=True))
            return 'ok'
        except BaseException as error:
            emit(json.dumps({'output_type': 'error', 'ename': type(error).__name__, 'evalue': str(error)[:65536],
                'traceback': [plain(line)[:65536] for line in (
                    traceback.format_list([frame for frame in traceback.extract_tb(error.__traceback__) if frame.filename.startswith('<ChartPython cell ')])
                    + traceback.format_exception_only(type(error), error))][-20:]}, ensure_ascii=True))
            return 'error'
        finally:
            active_emit = None

user_builtins = dict(vars(builtins))
user_builtins['input'] = no_input
user = {'__name__': '__main__', '__builtins__': user_builtins}
`,y="/mnt/data";function x(r){if(!r||r.length>200||r==="."||r===".."||/[\\/\x00-\x1f\x7f]/.test(r))throw new l("invalid-file","Usá un nombre de archivo de hasta 200 caracteres, sin carpetas ni caracteres de control.");return`${y}/${r}`}class M{constructor(t){E(this,"executionCount",0);E(this,"namespace");this.py=t,t.FS.mkdirTree(y),this.namespace=t.runPython("dict()")}async initialize(){await this.py.runPythonAsync(P,{globals:this.namespace})}async execute(t,e){if(new TextEncoder().encode(t).byteLength>102400)throw new l("too-large","La celda supera 100 KiB de código. Dividila en varias celdas.");const s=[],n=++this.executionCount,i=1044480;let d=0,S=0,T=!1;const C=g=>{const a=JSON.parse(g),k=()=>{if(a.output_type!=="error")return;const h={output_type:"error",ename:a.ename.slice(0,100),evalue:a.evalue.slice(0,256),traceback:[]};s.push(h),e==null||e(structuredClone(h))};if(T){k();return}let b=new TextEncoder().encode(g).byteLength;if(d+b>i&&(a.output_type==="display_data"||a.output_type==="execute_result")&&(a.data={"text/plain":a.data["text/plain"]??""},b=new TextEncoder().encode(JSON.stringify(a)).byteLength),d+b>i||++S>2e3){if(a.output_type==="stream"&&d<i&&S<=2e3){const B=a.text.slice(0,Math.max(0,Math.floor((i-d-256)/6)));if(B){const F={...a,text:B};s.push(F),e==null||e({...F})}}T=!0;const h={output_type:"stream",name:"stderr",text:`
[Salida truncada: se alcanzó el límite de 1 MiB o 2000 fragmentos.]
`};s.push(h),e==null||e(h),k();return}d+=b;const _=s[s.length-1];(_==null?void 0:_.output_type)==="stream"&&a.output_type==="stream"&&_.name===a.name?_.text+=a.text:s.push(structuredClone(a)),e==null||e(a)},m=this.namespace;m.set("_code",t),m.set("_count",n),m.set("_emit",C);try{const g=await this.py.runPythonAsync("await execute(_code, _count, _emit)",{globals:this.namespace});return{executionCount:n,outputs:s,status:g==="ok"?"ok":"error"}}finally{m.delete("_code"),m.delete("_count"),m.delete("_emit")}}upload(t,e){const s=x(t);if(!ArrayBuffer.isView(e)||e.BYTES_PER_ELEMENT!==1||e.byteLength>10485760)throw new l("too-large","Cada archivo puede ocupar hasta 10 MiB.");if(this.listFiles().filter(i=>i.name!==t).reduce((i,d)=>i+d.size,e.byteLength)>20971520)throw new l("too-large","Los archivos del kernel superan 20 MiB. Reiniciá Python para liberarlos.");if(this.py.FS.readdir(y).includes(t)&&!this.py.FS.isFile(this.py.FS.lstat(s).mode))throw new l("invalid-file","El nombre pertenece a una carpeta o enlace. Elegí otro nombre.");return this.py.FS.writeFile(s,e),s}listFiles(){return this.py.FS.readdir(y).filter(t=>t!=="."&&t!=="..").flatMap(t=>{const e=this.py.FS.lstat(x(t));return this.py.FS.isFile(e.mode)?[{name:t,size:e.size}]:[]}).sort((t,e)=>t.name.localeCompare(e.name))}download(t){const e=x(t),s=this.py.FS.lstat(e);if(!this.py.FS.isFile(s.mode))throw new l("invalid-file","Solo se pueden descargar archivos, no carpetas o enlaces.");if(s.size>10485760)throw new l("too-large","El archivo supera el límite de descarga de 10 MiB.");return this.py.FS.readFile(e)}get memoryBytes(){var t;return(t=this.py._module)==null?void 0:t.HEAPU8.byteLength}dispose(){this.namespace.destroy()}}const w="/static/vendor/pyodide/0.26.4/",c=globalThis;let f=null;function A(r){return f||(f=(async()=>{r({state:"iniciando",detail:"Cargando Python, pandas, NumPy, SciPy y statsmodels…"}),c.importScripts(w+"pyodide.js");const t=await c.loadPyodide({indexURL:w,lockFileURL:w+"pyodide-lock.json",packages:["statsmodels"],stdin:()=>{},stdout:()=>{},stderr:()=>{}}),e=new M(t);return await e.initialize(),e})().catch(t=>{throw f=null,t})),f}let v=!1;c.onmessage=async({data:r})=>{if(v){c.postMessage({id:r.id,kind:"error",code:"busy",message:"Python ya está ejecutando una operación."});return}v=!0;let t=!1;const e=s=>c.postMessage({id:r.id,kind:"status",status:s});try{const s=await A(e);t=!0,e({state:"ocupado",detail:r.kind==="execute"?"Ejecutando celda…":"Procesando…",memoryBytes:s.memoryBytes});let n;switch(r.kind){case"warmup":break;case"execute":n=await s.execute(r.code,i=>c.postMessage({id:r.id,kind:"output",output:i}));break;case"upload":n=s.upload(r.name,r.bytes);break;case"listFiles":n=s.listFiles();break;case"download":n=s.download(r.name);break}e({state:"listo",memoryBytes:s.memoryBytes}),c.postMessage({id:r.id,kind:"done",result:n})}catch(s){e({state:t?"listo":"muerto"}),c.postMessage({id:r.id,kind:"error",code:s instanceof l?s.code:t?"invalid-file":"load-failed",message:s instanceof Error?s.message:String(s)})}finally{v=!1}}})();
