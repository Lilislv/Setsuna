const {build} = require('esbuild');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {readFileSync} = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
 const bundle = await build({stdin:{contents:`
  import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
  import SettingsAudio from './src/components/Settings/SettingsAudio';
  window.calls=[];window.online=false;
  window.Audio=class {play(){return Promise.resolve()} pause(){} removeAttribute(){} load(){}};
  window.__TAURI_INTERNALS__={invoke:async(command)=>{
   window.calls.push(command);
   if(command==='plugin:dialog|open')return 'C:/Audio/android.db';
   if(command==='inspect_local_audio_database')return {filename:'android.db',entries:23456,sources:['nhk16','shinmeikai8']};
   if(command==='lookup_online_audio' && !window.online)return null;
   if(command==='lookup_online_audio'||command==='lookup_local_audio')return {data:'SUQzAg==',mimeType:'audio/mpeg',filename:'sample.mp3',source:command==='lookup_local_audio'?'nhk16':'JapanesePod101',speaker:''};
   throw Error(command);
  }};
  function App(){const [settings,set]=useState({appLanguage:'ru',dictionaryAudioSource:'online'});return <SettingsAudio settings={settings} updateSetting={(key,value)=>set(old=>({...old,[key]:value}))}/>}
  createRoot(document.getElementById('root')).render(<App/>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'}});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:850,height:1020}});page.setDefaultTimeout(10000);
  await page.setContent('<meta charset="utf-8"><div id="root"></div>');
  await page.addStyleTag({content:readFileSync('src/App.css','utf8').replace(/^@import.*$/m,'')+readFileSync('src/components/SettingsModal.css','utf8')+readFileSync('src/components/Settings/SettingsAudio.css','utf8')+'body{overflow:auto}#root{max-width:740px;margin:28px auto;padding:0 20px}'});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  assert.equal(await page.locator('.audio-database').count(),0);
  await page.locator('#audio-source').selectOption('online-first');
  await page.getByRole('button',{name:'Выбрать файл…'}).click();
  await page.getByText('Подключён',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Прослушать пример'}).click();
  await page.getByRole('status').filter({hasText:'Локальная база · nhk16'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.startsWith('lookup_'))),['lookup_online_audio','lookup_local_audio']);
  await page.evaluate(()=>{window.calls=[];window.online=true});
  await page.getByRole('button',{name:'Прослушать пример'}).click();
  await page.getByRole('status').filter({hasText:'Онлайн · JapanesePod101'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.startsWith('lookup_'))),['lookup_online_audio']);
  await page.screenshot({path:'output/audio-settings-0.2.0.png',fullPage:true});
  await page.getByRole('button',{name:'Отключить',exact:true}).click();
  await page.getByText('Не подключён',{exact:true}).waitFor();
  assert.equal(await page.locator('.audio-file-path').count(),0);
  console.log('PASS audio source selection, file status, online-first fallback, online byte reuse, disconnect');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
