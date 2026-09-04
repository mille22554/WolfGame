import fs from 'fs';
import path from 'path';

const state = JSON.parse(fs.readFileSync('game-state.json','utf-8'));
const players = state.players;

function roleToChinese(role){
  const map={ villager:'村民', seer:'占卜師', medium:'靈能者', guard:'獵人', mason:'共有者', werewolf:'人狼', madman:'狂人' };
  return map[role]||role;
}
function roleDesc(role){
  const map={
    villager:'無特殊能力，靠推理與投票找出人狼',
    seer:'每夜選擇一名存活玩家查驗，結果為「村人」或「人狼」（狂人顯示為村人）',
    medium:'只能得知白天被投票出局者的身分（「村人」或「人狼」），夜間被殺者無法得知',
    guard:'每夜守護一人免於人狼襲擊，可連續守護同一人，第一天不可守護',
    mason:'雙人組，互相知道對方身分，夜間可私聊，查驗結果為「村人」',
    werewolf:'夜間互相認識並合謀，全體共同選擇一人殺害，查驗結果為「人狼」',
    madman:'無特殊能力，查驗結果為「村人」，人狼勝則狂人勝（狂人不知道誰是人狼，但人狼知道狂人是誰）',
  };
  return map[role]||'';
}
function teamToChinese(team){
  return team==='werewolf' ? '人狼陣營 🔴' : '村人陣營 🟢';
}

// Group wolves
const wolves = players.filter(p=>p.role==='werewolf');
const wolfList = wolves.map(p=>`P${p.id} ${p.personality.name}（${p.personality.id}）`).join('、');

// Build memory for each persona folder
for(const p of players){
  const personaId = p.personality.id;
  const dir = path.join('character', personaId);
  if(!fs.existsSync(dir)) {
    console.error(`missing dir ${dir}`);
    continue;
  }
  let lines=[];
  lines.push(`# P${p.id} ${p.personality.name} 的當局記錄`);
  lines.push(``);
  lines.push(`## 你的角色`);
  lines.push(`- 你是 P${p.id} ${p.personality.name}，${p.personality.occupation}`);
  lines.push(`- 角色：${roleToChinese(p.role)}`);
  lines.push(`- 陣營：${teamToChinese(p.team)}`);
  lines.push(`- 能力說明：${roleDesc(p.role)}`);
  lines.push(``);
  // 同伴資訊
  if(p.role==='werewolf'){
    const allies = wolves.filter(w=>w.id!==p.id);
    if(allies.length>0){
      lines.push(`## 你的同夥（人狼）`);
      lines.push(`- 同夥：${allies.map(a=>`P${a.id} ${a.personality.name}`).join('、')}`);
      lines.push(`- 人狼團隊（共 ${wolves.length} 人）：${wolves.map(w=>`P${w.id}`).join('、')}`);
      lines.push(``);
    } else {
      lines.push(`## 你的同夥`);
      lines.push(`- 你是唯一的人狼`);
      lines.push(``);
    }
    lines.push(`> 提醒：人狼夜間共同決定殺一人（不可各殺一個），不可殺自己人，GM 不會洩露守衛/占卜等其他角色行動`);
    lines.push(`> 你知道誰是狂人（狂人是己方陣營，協助人狼獲勝），絕對不可襲擊狂人；只有狂人不知道誰是人狼`);
    lines.push(``);
  } else if(p.role==='mason' && p.masonPartnerId){
    const partner = players.find(x=>x.id===p.masonPartnerId);
    lines.push(`## 你的共有者夥伴`);
    lines.push(`- 夥伴：P${partner.id} ${partner.personality.name}（${partner.personality.id}）`);
    lines.push(`- 你們互相知道對方是共有者，夜間可在共有者頻道私聊`);
    lines.push(``);
  } else if(p.role==='seer'){
    lines.push(`> 你每晚必須查驗一人，結果為「村人」或「人狼」`);
    lines.push(``);
  } else if(p.role==='guard'){
    lines.push(`> 你每晚必須守護一人（Day1 不可守護），可連續守同一人`);
    lines.push(``);
  } else if(p.role==='medium'){
    lines.push(`> 你在每天拂曉（白天開始前）自動得知前一天被票死者的身分，結果為「村人」或「人狼」（僅私下告知）`);
    lines.push(``);
  }
  lines.push(`## 當前狀態`);
  lines.push(`Day ${state.day} / ${state.phase === 'setup' ? '準備階段' : state.phase}`);
  lines.push(`存活（${players.filter(x=>x.alive).length}人）：全員存活`);
  lines.push(``);
  lines.push(`## 你的筆記`);
  lines.push(`（在遊戲過程中自行補充筆記、觀察、懷疑、信任等）`);
  lines.push(``);
  const content = lines.join('\n');
  fs.writeFileSync(path.join(dir,'memory.md'), content, 'utf-8');
  console.log(`✅ ${personaId} -> P${p.id} ${p.role}`);
}

// 校驗 Checklist
console.log('\n--- 校驗 Checklist ---');
let ok=true;
for(const p of players){
  const personaId = p.personality.id;
  const memPath = path.join('character', personaId, 'memory.md');
  const mem = fs.readFileSync(memPath,'utf-8');
  const hasP = mem.includes(`P${p.id} ${p.personality.name}`);
  const hasRole = mem.includes(roleToChinese(p.role));
  let hasPartner=true;
  if(p.role==='werewolf'){
    for(const w of wolves){
      if(!mem.includes(`P${w.id}`)) hasPartner=false;
    }
  } else if(p.role==='mason'){
    if(!mem.includes(`P${p.masonPartnerId}`)) hasPartner=false;
  }
  const pass = hasP && hasRole && hasPartner;
  console.log(`${pass?'✅':'❌'} P${p.id} ${personaId} ${p.role} ${hasP?'P ok':''} ${hasRole?'role ok':''} ${hasPartner?'partner ok':''}`);
  if(!pass) ok=false;
}
if(!ok){
  console.error('校驗失敗');
  process.exit(1);
}
console.log('✅ 全部校驗通過');

// 生成 game-public.md
const publicPath = path.join('character','game-public.md');
let pub=[];
pub.push(`# 人狼遊戲 — 公開狀態`);
pub.push(``);
pub.push(`## 遊戲資訊`);
pub.push(`- 玩家人數：15`);
pub.push(`- 職業配置：村民 6、占卜師 1、靈能者 1、守衛 1、共有者 2、人狼 3、狂人 1`);
pub.push(``);
pub.push(`## 玩家列表`);
for(const p of players){
  // 公開僅顯示 P# + 名字 + 職業「未公開」
  pub.push(`- P${p.id} ${p.personality.name}（${p.personality.id}）— ${p.personality.occupation}`);
}
pub.push(``);
pub.push(`## 當前狀態`);
pub.push(`Day ${state.day} / 準備階段（等待第一夜）`);
if(state.phase==='setup'){
  pub.push(`存活（15人）：全員存活 — ${players.map(p=>`P${p.id} ${p.personality.name}`).join('、')}`);
} else {
  pub.push(`存活（${players.filter(x=>x.alive).length}人）：${players.filter(x=>x.alive).map(p=>`P${p.id} ${p.personality.name}`).join('、')}`);
}
pub.push(`死亡（0人）：無`);
pub.push(``);
pub.push(`## 對話紀錄`);
pub.push(`（尚未開始）`);
pub.push(``);
pub.push(`## 投票紀錄`);
pub.push(`（尚未投票）`);
pub.push(``);
pub.push(`## 夜間紀錄`);
pub.push(`（無）`);
pub.push(``);
fs.writeFileSync(publicPath, pub.join('\n'), 'utf-8');
console.log(`\n✅ game-public.md 已重建`);
console.log(pub.join('\n'));
