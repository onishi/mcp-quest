import type { ClassDef, FactDef, ItemDef, LocationDef, MonsterDef, NpcDef, RaceDef, SpellDef } from "../types.js";

export const WORLD_ID = "eldia";
export const WORLD_NAME = "エルディア";

export const INTRO =
  "剣と魔法の世界エルディア。王国の辺境にあるリーフェン村は、精霊の森と閉鎖された旧鉱山、読めない文字の刻まれた古代遺跡に囲まれた小さな村だ。" +
  "冒険者ギルドの支部があり、酒場「眠れる竜亭」には今日も依頼の噂が集まる。あなたの冒険の結果は、この世界の歴史として残り続ける。";

export const locations: LocationDef[] = [
  { id: "loc_riefen", name: "リーフェン村", region: "riefen", description: "街道の終点にある辺境の村。石垣と麦畑、古い水車小屋がある。" },
  { id: "loc_square", name: "村の広場", region: "riefen", description: "古井戸と掲示板のある広場。朝市が立つ。" },
  { id: "loc_tavern", name: "酒場「眠れる竜亭」", region: "riefen", description: "暖炉と古い樫のカウンター。隅には誰も座らない席がひとつある。" },
  { id: "loc_guild", name: "冒険者ギルド リーフェン支部", region: "riefen", description: "依頼の掲示板と、少し傾いた受付台。" },
  { id: "loc_apothecary", name: "薬屋", region: "riefen", description: "乾燥した薬草の匂いが満ちる店。奥の部屋はいつも鍵がかかっている。" },
  { id: "loc_smithy", name: "ブランの鍛冶屋", region: "riefen", description: "ドワーフの鍛冶師が営む店。炉の火は絶えない。" },
  { id: "loc_inn", name: "宿屋「麦の穂」", region: "riefen", description: "旅人と行商人が泊まる素朴な宿。" },
  { id: "loc_chapel", name: "光の教会", region: "riefen", description: "小さな礼拝堂。鐘楼の鐘は長いあいだ鳴っていない。" },
  { id: "loc_spirit_forest", name: "精霊の森", region: "riefen", description: "村の東に広がる古い森。精霊の伝承と薬草で知られる。" },
  { id: "loc_old_mine", name: "旧鉱山", region: "riefen", description: "二十年前に閉鎖された銀鉱山。最近はゴブリンが住み着いたという。" },
  { id: "loc_ruins", name: "古代遺跡", region: "riefen", description: "丘の上の崩れた石造りの遺構。読めない文字が刻まれている。" },
  { id: "loc_highway", name: "街道", region: "riefen", description: "王都へ続く石畳の街道。商隊と行商人が行き交う。" },
];

export const npcs: NpcDef[] = [
  { id: "npc_elena", manner: "静かで丁寧な口調。疲れが滲み、時々言葉を選ぶように黙る。", rumors: ["最近は夜遅くまで薬の調合をしている", "森の薬草は春より秋の方が効き目が強い"], name: "薬師エレナ", role: "薬師", location: "loc_apothecary", publicProfile: "村の医療を一手に担う物静かな薬師。", goals: ["病の娘リラを救う"], fears: ["禁術の研究が露見すること"], secrets: ["禁じられた魔法を研究している"] },
  { id: "npc_lila", manner: "人懐っこく、思ったことをすぐ口にする。咳き込むことがある。", rumors: ["トビは森のことなら何でも知っている", "王都には空飛ぶ船があるって本当？"], name: "リラ", role: "エレナの娘", location: "loc_apothecary", publicProfile: "病弱だが好奇心旺盛な少女。", goals: ["外の世界を見る"], fears: ["母を困らせること"], secrets: [] },
  { id: "npc_gord", manner: "寡黙でぶっきらぼう。短い言葉で話すが、客への気配りは細やか。", rumors: ["今年の麦酒は出来がいい", "森の奥には夜、行くもんじゃない"], name: "ゴルド", role: "酒場の主人", location: "loc_tavern", publicProfile: "眠れる竜亭の主人。寡黙で、誰も座らない席に毎晩酒を置く。", goals: ["友との約束を果たす"], fears: ["忘れられること"], secrets: ["三十年前、友を森に置いて逃げた"] },
  { id: "npc_marta", manner: "豪快で歯切れがいい。冒険者を「若いの」と呼ぶ。", rumors: ["ギルドの依頼は減る一方だ", "王都の本部はこの支部を閉めたがっている"], name: "マルタ", role: "ギルド支部長", location: "loc_guild", publicProfile: "元冒険者の豪快な支部長。依頼の采配を担う。", goals: ["村の安全と支部の存続"], fears: ["支部の閉鎖"], secrets: [] },
  { id: "npc_bran", manner: "口が悪く、ドワーフ訛り。職人の話になると饒舌。", rumors: ["いい鉄は嘘をつかねえ", "旧鉱山の銀は王国一だった"], name: "ブラン", role: "鍛冶師（ドワーフ）", location: "loc_smithy", publicProfile: "腕は確かだが口が悪いドワーフの鍛冶師。", goals: ["旧鉱山の銀で名剣を打つ"], fears: [], secrets: ["鉱山閉鎖の真相を知っている"] },
  { id: "npc_father_alan", manner: "穏やかで丁寧。説教くさくならないよう気をつけている。", rumors: ["教会の鐘は十年鳴っていない", "光の神は迷える者を見捨てない"], name: "神官アラン", role: "神官", location: "loc_chapel", publicProfile: "禁術の取締りも担う温厚な神官。", goals: ["鐘を再び鳴らす"], fears: ["信仰の衰え"], secrets: ["エレナに命を救われた恩がある"] },
  { id: "npc_tobi", manner: "元気で早口。褒められると照れる。", rumors: ["月光草は月の夜に光るんだ", "森のエルフは怖いけど、本当は優しいと思う"], name: "トビ", role: "薬草採りの少年", location: "loc_apothecary", publicProfile: "エレナの手伝いをする元気な少年。", goals: ["一人前の薬草採りになる"], fears: ["暗い場所"], secrets: [] },
  { id: "npc_hilda", manner: "噂好きで声を潜めるのが癖。話が長い。", rumors: ["ゴルドの酒場の隅の席には誰も座らない", "行商人のカスはまた値上げした"], name: "ヒルダ", role: "宿屋の女将", location: "loc_inn", publicProfile: "村一番の情報通。", goals: ["宿の繁盛"], fears: [], secrets: [] },
  { id: "npc_old_wen", manner: "ゆっくりと昔話のように語る。", rumors: ["丘の上の遺跡には触れるなと祖父に言われた", "昔はこの村も銀で栄えた"], name: "長老ウェン", role: "村長", location: "loc_riefen", publicProfile: "村の古い伝承に詳しい長老。", goals: ["村を守る"], fears: ["遺跡の封印が解かれること"], secrets: [] },
  { id: "npc_kass", manner: "調子がよく、何でも商売に結びつける。", rumors: ["王都では東方の香辛料が流行っている", "街道の北で盗賊を見たという話がある"], name: "カス", role: "行商人", location: "loc_highway", publicProfile: "口のうまい行商人。品揃えは日によって違う。", goals: ["一山当てる"], fears: ["盗賊"], secrets: [] },
  { id: "npc_selphine", manner: "簡潔で冷ややか。人間を「森の客人」と呼ぶ。", rumors: ["森は与え、そして奪う", "光を追う者は帰らない"], name: "セルフィーネ", role: "エルフの狩人", location: "loc_spirit_forest", publicProfile: "森に住むエルフの狩人。人間とは距離を置く。", goals: ["森の均衡を守る"], fears: [], secrets: [] },
  { id: "npc_grik", manner: "片言の人間語。単語を区切って話す。", rumors: ["ニンゲン、コワイ", "シタ、イカナイ"], name: "グリク", role: "ゴブリンの族長", location: "loc_old_mine", publicProfile: "旧鉱山に住み着いたゴブリンたちの族長。", goals: ["一族が冬を越す"], fears: ["地下深くの何か"], secrets: ["地下の坑道から追われて鉱山上層に来た"] },
  { id: "npc_mira", manner: "はきはきした元鉱夫。鉱山の話になると熱が入る。", rumors: ["鉱山が再開すれば村は生き返る", "坑道の地図はブランが持っているはず"], name: "ミラ", role: "元鉱夫", location: "loc_riefen", publicProfile: "鉱山の再開を願う元鉱夫。", goals: ["鉱山の再開"], fears: [], secrets: [] },
  { id: "npc_rolf", manner: "真面目で心配性。すぐ規則を持ち出す。", rumors: ["夜の外出は控えてほしい", "ゴブリンの足跡を見たという話がある"], name: "ロルフ", role: "衛兵", location: "loc_square", publicProfile: "村でただ一人の衛兵。真面目だが心配性。", goals: ["村の治安"], fears: ["ゴブリンの襲撃"], secrets: [] },
  { id: "npc_old_spirit", manner: "葉擦れのような声。片言で、ゆっくり話す。", rumors: ["森ハ覚エテイル", "約束ハ消エナイ"], name: "老いた精霊", role: "森の精霊", location: "loc_spirit_forest", publicProfile: "伝承に語られる森の精霊。", goals: ["約束を伝える"], fears: ["消えること"], secrets: [] },
];

export const items: ItemDef[] = [
  { id: "short_sword", name: "ショートソード", kind: "weapon", description: "扱いやすい片手剣。", value: 10, damage: "1d6", attackAbility: "str" },
  { id: "long_sword", name: "ロングソード", kind: "weapon", description: "戦士の標準的な剣。", value: 15, damage: "1d8", attackAbility: "str" },
  { id: "dagger", name: "ダガー", kind: "weapon", description: "身軽な者の短剣。", value: 4, damage: "1d4", attackAbility: "dex" },
  { id: "mace", name: "メイス", kind: "weapon", description: "神官の鎚矛。", value: 8, damage: "1d6", attackAbility: "str" },
  { id: "staff", name: "樫の杖", kind: "weapon", description: "魔法使いの杖。", value: 3, damage: "1d4", attackAbility: "str" },
  { id: "shortbow", name: "ショートボウ", kind: "weapon", description: "狩猟用の弓。", value: 12, damage: "1d6", attackAbility: "dex" },
  { id: "leather_armor", name: "革鎧", kind: "armor", description: "軽い革の鎧。", value: 10, armor: 1 },
  { id: "chain_mail", name: "鎖帷子", kind: "armor", description: "重いが頼れる鎧。", value: 30, armor: 3 },
  { id: "potion_minor", name: "傷薬", kind: "consumable", description: "エレナ謹製の傷薬。", value: 5, heal: "2d4+2" },
  { id: "antidote", name: "解毒薬", kind: "consumable", description: "毒消しの苦い薬。", value: 5, heal: "1d4" },
  { id: "rations", name: "保存食", kind: "consumable", description: "干し肉と堅焼きパン。", value: 1, heal: "1" },
  { id: "rope", name: "ロープ", kind: "tool", description: "丈夫な麻のロープ。", value: 1 },
  { id: "torch", name: "松明", kind: "tool", description: "暗い場所を照らす。", value: 1 },
  { id: "lantern", name: "ランタン", kind: "tool", description: "油のランタン。", value: 5 },
  { id: "thieves_tools", name: "盗賊の道具", kind: "tool", description: "錠前を開ける細工道具。", value: 10 },
  { id: "holy_symbol", name: "聖印", kind: "tool", description: "光の神の聖印。", value: 5 },
  { id: "spellbook", name: "呪文書", kind: "tool", description: "書き込みだらけの呪文書。", value: 20 },
  { id: "herb_moonleaf", name: "月光草", kind: "treasure", description: "月夜に淡く光る薬草。", value: 6 },
  { id: "old_silver_coin", name: "古い銀貨", kind: "treasure", description: "見慣れない紋章の刻まれた銀貨。", value: 3 },
  { id: "goblin_totem", name: "ゴブリンのトーテム", kind: "quest", description: "骨と羽で飾られた族長の証。", value: 0 },
  { id: "mine_map", name: "旧鉱山の地図", kind: "quest", description: "坑道が書き込まれた古い地図。", value: 0 },
  { id: "silver_ore", name: "銀鉱石", kind: "treasure", description: "旧鉱山の良質な銀鉱石。", value: 12 },
  { id: "spirit_charm", name: "精霊のお守り", kind: "treasure", description: "微かに温かい木の実のお守り。", value: 0 },
  { id: "guild_badge", name: "ギルド認定章", kind: "treasure", description: "リーフェン支部の認定冒険者の証。", value: 0 },
  { id: "tobis_satchel", name: "トビの採集袋", kind: "quest", description: "薬草が半分ほど入った小さな袋。", value: 0 },
];

export const monsters: MonsterDef[] = [
  { id: "goblin", name: "ゴブリン", hp: 6, defense: 11, attack: 2, damage: "1d4", description: "小柄で狡猾な小鬼。" },
  { id: "goblin_chief", name: "ゴブリンの族長", hp: 14, defense: 13, attack: 3, damage: "1d6+1", description: "一族を率いる老練なゴブリン。" },
  { id: "giant_rat", name: "大ネズミ", hp: 4, defense: 10, attack: 1, damage: "1d3", description: "坑道に住む大きなネズミ。" },
  { id: "wolf", name: "森狼", hp: 8, defense: 12, attack: 3, damage: "1d6", description: "飢えた森の狼。" },
  { id: "cave_spider", name: "洞窟グモ", hp: 9, defense: 12, attack: 3, damage: "1d6", description: "毒牙を持つ大蜘蛛。" },
  { id: "forest_wisp", name: "迷いの鬼火", hp: 5, defense: 14, attack: 2, damage: "1d4", description: "旅人を惑わす光。" },
  { id: "skeleton", name: "骸骨兵", hp: 10, defense: 12, attack: 2, damage: "1d6", description: "遺跡を守る古い骸骨。" },
];

export const spells: SpellDef[] = [
  { id: "firebolt", name: "火矢", classes: ["mage"], mpCost: 2, kind: "attack", dice: "1d10", ability: "int", description: "炎の矢を放つ。" },
  { id: "light", name: "灯火", classes: ["mage", "cleric"], mpCost: 1, kind: "utility", ability: "int", description: "周囲を照らす光を灯す。暗所の調査が容易になる。" },
  { id: "heal", name: "癒しの祈り", classes: ["cleric"], mpCost: 2, kind: "heal", dice: "2d4+2", ability: "wil", description: "傷を癒す。" },
  { id: "smite", name: "聖撃", classes: ["cleric"], mpCost: 2, kind: "attack", dice: "1d8", ability: "wil", description: "光の力で敵を打つ。" },
];

export const facts: FactDef[] = [
  { id: "fact_goblins_in_mine", text: "旧鉱山にゴブリンが住み着いている。", visibility: "public", initial: true },
  { id: "fact_goblins_fled_depths", text: "ゴブリンたちは鉱山の深部にいる何かから逃れて上層に来た。", visibility: "secret" },
  { id: "fact_goblins_relocated", text: "ゴブリンたちは村と協定を結び、鉱山の上層から森の外れへ移り住んだ。", visibility: "public" },
  { id: "fact_goblins_driven_out", text: "ゴブリンたちは冒険者に討たれ、旧鉱山から追い払われた。", visibility: "public" },
  { id: "fact_goblin_truce", text: "ゴブリンたちは村との境界を守る約束をして鉱山に留まった。", visibility: "public" },
  { id: "fact_mine_depths_danger", text: "旧鉱山の深部に、正体不明の何かが潜んでいる。", visibility: "public" },
  { id: "fact_tobi_rescued", text: "薬草採りのトビは森で迷い、冒険者に救出された。", visibility: "public" },
  { id: "fact_tobi_lost", text: "薬草採りのトビは森で行方不明のままだ。", visibility: "public" },
  { id: "fact_spirit_grove", text: "精霊の森の奥には、月光草の群生する精霊の泉がある。", visibility: "secret" },
  { id: "fact_elena_forbidden_research", text: "薬師エレナは禁じられた魔法を研究している。", visibility: "secret" },
  { id: "fact_spirit_promise", text: "老いた精霊は、三十年前に交わされた約束を伝えようとしている。", visibility: "secret" },
  { id: "fact_spirit_promise_delivered", text: "眠れる竜亭の空席に置かれた酒の謎は解け、三十年越しの約束が果たされた。", visibility: "public" },
  { id: "fact_gord_seeks_friend", text: "酒場の主人ゴルドは、失踪した友の足跡を探す決意をした。", visibility: "public" },
  { id: "fact_old_coin_crest", text: "古い銀貨の紋章は、古代遺跡の扉に刻まれた紋章と同じだ。", visibility: "secret" },
];

export const races: RaceDef[] = [
  { id: "human", name: "人間", bonus: { cha: 1 }, description: "適応力に富む。" },
  { id: "elf", name: "エルフ", bonus: { per: 1 }, description: "鋭い感覚と長い寿命を持つ。" },
  { id: "dwarf", name: "ドワーフ", bonus: { wil: 1 }, description: "頑健で頑固。" },
];

export const classes: ClassDef[] = [
  {
    id: "warrior", name: "戦士", hp: 14, mp: 0,
    abilities: { str: 3, dex: 1, int: 0, wil: 1, cha: 0, per: 0 },
    trainedSkills: ["athletics", "intimidation"],
    startingItems: ["long_sword", "chain_mail", "potion_minor", "rations", "torch"],
    equipped: { weapon: "long_sword", armor: "chain_mail" }, spells: [],
  },
  {
    id: "mage", name: "魔法使い", hp: 8, mp: 8,
    abilities: { str: -1, dex: 1, int: 3, wil: 1, cha: 0, per: 1 },
    trainedSkills: ["arcana", "lore"],
    startingItems: ["staff", "spellbook", "potion_minor", "rations"],
    equipped: { weapon: "staff" }, spells: ["firebolt", "light"],
  },
  {
    id: "thief", name: "盗賊", hp: 10, mp: 0,
    abilities: { str: 0, dex: 3, int: 1, wil: 0, cha: 1, per: 2 },
    trainedSkills: ["stealth", "acrobatics", "deception", "perception"],
    startingItems: ["dagger", "shortbow", "leather_armor", "thieves_tools", "rope", "potion_minor"],
    equipped: { weapon: "dagger", armor: "leather_armor" }, spells: [],
  },
  {
    id: "cleric", name: "僧侶", hp: 12, mp: 6,
    abilities: { str: 1, dex: 0, int: 0, wil: 3, cha: 1, per: 0 },
    trainedSkills: ["medicine", "insight", "persuasion"],
    startingItems: ["mace", "leather_armor", "holy_symbol", "potion_minor", "rations"],
    equipped: { weapon: "mace", armor: "leather_armor" }, spells: ["heal", "light", "smite"],
  },
];
