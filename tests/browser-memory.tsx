import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import TextContainer from '../src/components/TextContainer';
import Lookuper from '../src/components/Lookuper';
const lines = Array.from({ length: 20000 }, (_, index) => `${index} 彼女は食べさせられませんでした。${'今日はいい天気です。'.repeat(index % 7)}`);
const entries = Array.from({ length: 2000 }, (_, index) => ({ term: `語${index}`, reading: 'ご', dict_name: 'Test', definition: '["definition"]', tags: '', frequencies: [], pitches: [], pronunciations: [], deinflection_reasons: [], source_length: 1 }));
const stack = [{ entries, word:'語', sentence:'語', rect: new DOMRect(30,30,20,20) }];
const settings = { appLanguage:'en', dictionaries:[], lookupHotkey:'Shift' } as any;
function Harness() {
 const [orientation, setOrientation] = useState('vertical');
 const [search, setSearch] = useState(-1);
 const [popup, setPopup] = useState(false);
 const [checks, setChecks] = useState<string[]>([]);
 useEffect(() => {
   let cancelled = false;
   const pause = () => new Promise(resolve => setTimeout(resolve, 1500));
   const record = (name, passed, details) => { if (!cancelled) setChecks(previous => [...previous, `${passed ? 'PASS' : 'FAIL'} ${name}: ${details}`]); };
   void (async () => {
     await pause(); if (cancelled) return;
     const count = document.querySelectorAll('.text-line').length;
     record('bounded vertical history', count > 0 && count < 100, count);
     record('tail visible', !!document.querySelector('[data-index="19999"]'), '19999');
     setSearch(10000);
     await pause(); if (cancelled) return;
     const target = document.querySelector('[data-index="10000"]')?.getBoundingClientRect();
     record('search mounts and shows distant line', !!target && target.right > 0 && target.left < innerWidth, JSON.stringify({ rect: target, scroll: document.querySelector('.text-container')?.scrollLeft, indices: Array.from(document.querySelectorAll('[data-index]')).map(el => el.getAttribute('data-index')) }));
     setSearch(-1); setOrientation('horizontal');
     await pause(); if (cancelled) return;
     const rows = document.querySelectorAll('.text-line-wrapper').length;
     record('bounded horizontal history', rows > 0 && rows < 100, rows);
     record('horizontal tail visible', !!document.querySelector('[data-index="19999"]'), '19999');
     setPopup(true);
     await pause(); if (cancelled) return;
     const popup = document.querySelector('.dict-popup');
     record('dictionary first page', !!popup?.textContent?.includes('語19') && !popup?.textContent?.includes('語20'), popup?.querySelectorAll('*').length);
     const next = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Next');
     next?.click();
     await pause(); if (cancelled) return;
     record('dictionary next page', !!popup?.textContent?.includes('語20') && !popup?.textContent?.includes('語0'), popup?.querySelectorAll('*').length);
     setPopup(false);
   })();
   return () => { cancelled = true; };
 }, []);
 return <><style>{`html,body,#root{height:100%;margin:0;background:#202124;color:#ddd;--text-main:#ddd;--txt-font-size:26px}#root{display:flex;flex-direction:column}button{padding:8px}.dict-popup{position:fixed;background:#333;color:#ddd;max-height:80vh;overflow:auto;width:500px}`}</style>
 <div><button onClick={()=>setOrientation('horizontal')}>Horizontal</button><button onClick={()=>setOrientation('vertical')}>Vertical</button><button onClick={()=>setSearch(10000)}>Find 10000</button><button onClick={()=>setPopup(!popup)}>Dictionary</button></div>
 <pre>{checks.join('\n')}</pre>
 <TextContainer contentKey={orientation} lines={lines} textOrientation={orientation} furiganaMode="none" activeSearchLineIdx={search} onDelete={()=>{}} onEdit={()=>{}} />
 {popup && <Lookuper stack={stack} settings={settings} />}
 </>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
