import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
function scan(dir) {
 for (const item of readdirSync(dir,{withFileTypes:true})) {
  const path=join(dir,item.name);
  if(item.isDirectory())scan(path);
  else if(/\.(js|css|html)$/.test(path)) {
   assert.doesNotMatch(item.name,/yatsu/i,`Private entry in ${path}`);
   assert.doesNotMatch(readFileSync(path,'utf8'),/Yatsu|app\.yatsu\.moe|lookup_cambridge_api|manage_browser|native-browser-container|Cambridge Dictionary API/i,`Non-public feature in ${path}`);
  }
 }
}
scan('dist');
console.log('Public assets contain no private reader, Cambridge API or embedded browser');
