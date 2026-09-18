import sqlite3, os

ROOT = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(ROOT, "backend", "data", "lingdong.db")

# barcode -> relative image path
MAPPING = [
    ("6925303770556", "/uploads/汤达人酸酸辣辣（杯）.jpg"),
    ("6975176784785", "/uploads/元气减糖冰柠檬茶900ml.jpg"),
    ("6924743924154", "/uploads/乐事135g薯片墨西哥鸡汁番茄味★.jpg"),
    ("6902890264651", "/uploads/双汇105g鸡肉火腿肠（18支_件）.jpg"),
    ("6970512358996", "/uploads/佐滋榛子巧克力味蛋糕80g.jpg"),
    ("6972333772968", "/uploads/巧乐角面包（饼干碎奶油味）.jpg"),
    ("6901236333709", "/uploads/V1162 维达180抽_提悬挂式洗脸巾.jpg"),
    ("6937003703437", "/uploads/元气葡萄柚绿茶味冰茶900ml.jpg"),
    ("6937003706315", "/uploads/外星人电解质水青柠三效600ml.jpg"),
    ("6914068053189", "/uploads/GR226-01洁柔牌纸面巾（便利抽立体压花挂抽）320抽3层.jpg"),
    ("6925303797751", "/uploads/汤达人·肥汁米线.jpg"),
    ("6925303710187", "/uploads/红烧·袋.jpg"),
    ("6937003703840", "/uploads/外星人电解质水荔枝海盐950ml.png"),
    ("6920458837024", "/uploads/怡宝酸梅汤450ml.jpg"),
    ("6907992513645", "/uploads/伊利安慕希PET原味230ML.png"),
    ("6925303770563", "/uploads/汤达人日式豚骨（杯）.jpg"),
    ("6925303702496", "/uploads/统一春佛绿茶900ml.jpg"),
    ("6925303701536", "/uploads/统一双萃鸭屎香柠檬茶1L.jpg"),
    ("6925303796426", "/uploads/茄皇番茄牛肉面·桶.jpg"),
    ("6925303797461", "/uploads/日式汤达人·大大杯.jpg"),
    ("6925303740719", "/uploads/涨·酱拌·担担碗.jpg"),
    ("6902083814052", "/uploads/娃哈哈AD钙奶草莓味450ml.jpg"),
    ("6914068020082", "/uploads/JS008-01 洁柔80片婴儿湿巾.jpg"),
    ("6902083898618", "/uploads/营养快线原味500ml.jpg"),
    ("6973903121353", "/uploads/让茶无糖青柠芭乐茉莉500ml.jpg"),
    ("6923644241353", "/uploads/蒙牛早餐麦香250ML.jpg"),
    ("6954767410586", "/uploads/可乐益生元 500ml.jpg"),
    ("6920208924028", "/uploads/康师傅大食袋香辣牛肉.jpg"),
    ("6937962134617", "/uploads/康师傅好汤桶老母鸡汤面117g.jpg"),
    ("6937962130145", "/uploads/康师傅金汤肥牛面.png"),
    ("6920208924011", "/uploads/康师傅大食袋红烧牛肉.jpg"),
    ("6937962144715", "/uploads/康师傅韩式火鸡面拌面.jpg"),
    ("6920208916719", "/uploads/康师傅麻辣排骨面.jpg"),
    ("6971552201303", "/uploads/C2 番茄味脆纸署片饼干38g.jpg"),
    ("084501142315", "/uploads/康元早餐饼干.jpg"),
    ("6935270642121", "/uploads/白象汤好喝辣牛肉汤面119g*12桶.jpg"),
    ("4897090850174", "/uploads/Anemon3,118g比利时风味焦糖饼干.jpg"),
    ("6974354667506", "/uploads/Herlab 她研社深藏不露卫生巾（轻透款）290mm 6片装   QR.jpg"),
    ("6937003707138", "/uploads/外星人电解质水青柠500ml.jpg"),
    ("6925303792978", "/uploads/汤达人韩式（杯）.png"),
    ("6971329920895", "/uploads/依能蜜柠水1L.jpg"),
    ("6971329921007", "/uploads/依能蜜桃水1L.jpg"),
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