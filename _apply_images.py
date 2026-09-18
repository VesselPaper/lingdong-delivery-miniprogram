import sqlite3, os

ROOT = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(ROOT, "backend", "data", "lingdong.db")

# barcode -> relative image path
MAPPING = [
    ("6925303770556", "/store-img/姹よ揪浜洪吀閰歌荆杈ｏ紙鏉級.jpg"),
    ("6975176784785", "/store-img/鍏冩皵鍑忕硸鍐版煚妾尪900ml.jpg"),
    ("6924743924154", "/store-img/涔愪簨135g钖墖澧ㄨタ鍝ラ浮姹佺暘鑼勫懗鈽?jpg"),
    ("6902890264651", "/store-img/鍙屾眹105g楦¤倝鐏吙鑲狅紙18鏀痏浠讹級.jpg"),
    ("6970512358996", "/store-img/浣愭粙姒涘瓙宸у厠鍔涘懗铔嬬硶80g.jpg"),
    ("6972333772968", "/store-img/宸т箰瑙掗潰鍖咃紙楗煎共纰庡ザ娌瑰懗锛?jpg"),
    ("6901236333709", "/store-img/V1162 缁磋揪180鎶絖鎻愭偓鎸傚紡娲楄劯宸?jpg"),
    ("6937003703437", "/store-img/鍏冩皵钁¤悇鏌氱豢鑼跺懗鍐拌尪900ml.jpg"),
    ("6937003706315", "/store-img/澶栨槦浜虹數瑙ｈ川姘撮潚鏌犱笁鏁?00ml.jpg"),
    ("6914068053189", "/store-img/GR226-01娲佹煍鐗岀焊闈㈠肪锛堜究鍒╂娊绔嬩綋鍘嬭姳鎸傛娊锛?20鎶?灞?jpg"),
    ("6925303797751", "/store-img/姹よ揪浜郝疯偉姹佺背绾?jpg"),
    ("6925303710187", "/store-img/绾㈢儳路琚?jpg"),
    ("6937003703840", "/store-img/澶栨槦浜虹數瑙ｈ川姘磋崝鏋濇捣鐩?50ml.png"),
    ("6920458837024", "/store-img/鎬″疂閰告姹?50ml.jpg"),
    ("6907992513645", "/store-img/浼婂埄瀹夋厱甯孭ET鍘熷懗230ML.png"),
    ("6925303770563", "/store-img/姹よ揪浜烘棩寮忚睔楠紙鏉級.jpg"),
    ("6925303702496", "/store-img/缁熶竴鏄ヤ經缁胯尪900ml.jpg"),
    ("6925303701536", "/store-img/缁熶竴鍙岃悆楦睅棣欐煚妾尪1L.jpg"),
    ("6925303796426", "/store-img/鑼勭殗鐣寗鐗涜倝闈⒙锋《.jpg"),
    ("6925303797461", "/store-img/鏃ュ紡姹よ揪浜郝峰ぇ澶ф澂.jpg"),
    ("6925303740719", "/store-img/娑烽叡鎷屄锋媴鎷呯.jpg"),
    ("6902083814052", "/store-img/濞冨搱鍝圓D閽欏ザ鑽夎帗鍛?50ml.jpg"),
    ("6914068020082", "/store-img/JS008-01 娲佹煍80鐗囧┐鍎挎箍宸?jpg"),
    ("6902083898618", "/store-img/钀ュ吇蹇嚎鍘熷懗500ml.jpg"),
    ("6973903121353", "/store-img/璁╄尪鏃犵硸闈掓煚鑺箰鑼夎帀500ml.jpg"),
    ("6923644241353", "/store-img/钂欑墰鏃╅楹﹂250ML.jpg"),
    ("6954767410586", "/store-img/鍙箰鐩婄敓鍏?500ml.jpg"),
    ("6920208924028", "/store-img/搴峰笀鍌呭ぇ椋熻棣欒荆鐗涜倝.jpg"),
    ("6937962134617", "/store-img/搴峰笀鍌呭ソ姹ゆ《鑰佹瘝楦℃堡闈?17g.jpg"),
    ("6937962130145", "/store-img/搴峰笀鍌呴噾姹よ偉鐗涢潰.png"),
    ("6920208924011", "/store-img/搴峰笀鍌呭ぇ椋熻绾㈢儳鐗涜倝.jpg"),
    ("6937962144715", "/store-img/搴峰笀鍌呴煩寮忕伀楦￠潰鎷岄潰.jpg"),
    ("6920208916719", "/store-img/搴峰笀鍌呴夯杈ｆ帓楠ㄩ潰.jpg"),
    ("6971552201303", "/store-img/C2 鐣寗鍛宠剢绾哥讲鐗囬ゼ骞?8g.jpg"),
    ("084501142315", "/store-img/搴峰厓鏃╅楗煎共.jpg"),
    ("6935270642121", "/store-img/鐧借薄姹ゅソ鍠濊荆鐗涜倝姹ら潰119g*12妗?jpg"),
    ("4897090850174", "/store-img/Anemon3,118g姣斿埄鏃堕鍛崇劍绯栭ゼ骞?jpg"),
    ("6974354667506", "/store-img/Herlab 濂圭爺绀炬繁钘忎笉闇插崼鐢熷肪锛堣交閫忔锛?90mm 6鐗囪   QR.jpg"),
    ("6937003707138", "/store-img/澶栨槦浜虹數瑙ｈ川姘撮潚鏌?00ml.jpg"),
    ("6925303792978", "/store-img/姹よ揪浜洪煩寮忥紙鏉級.png"),
    ("6971329920895", "/store-img/渚濊兘铚滄煚姘?L.jpg"),
    ("6971329921007", "/store-img/渚濊兘铚滄姘?L.jpg"),
]

conn = sqlite3.connect(DB)
conn.execute("PRAGMA busy_timeout=3000")
cur = conn.cursor()
for b, path in MAPPING:
    cur.execute("UPDATE goods SET image=? WHERE barcode=?", (path, b))
    print("UPDATE", b, "rows=", cur.rowcount)
conn.commit()
barcodes = tuple(b for b, _ in MAPPING)
rows = cur.execute(
    "SELECT id, barcode, image, image IS NOT NULL AND image<>'' AS hasimg FROM goods WHERE barcode IN (%s)"
    % ",".join("?" for _ in barcodes),
    barcodes,
).fetchall()
filled = [r for r in rows if r[3]]
print("filled count =", len(filled), "/", len(rows))
conn.close()
