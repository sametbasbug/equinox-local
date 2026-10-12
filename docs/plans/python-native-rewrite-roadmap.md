# Equinox Local — Python tabanlı gerçek masaüstü yeniden yazım yol haritası

**Durum:** Yalnızca plan / çalışma takibi. Uygulama başlamadı. 2026-10-13.

> **BU DOSYA KANUN DEĞİLDİR.** Bu belge teknik şartname, bağlayıcı tasarım kararı, değiştirilemez görev sırası, otomatik çalışma izni veya yayın onayı **değildir**. Yalnızca neyi amaçladığımızı, ne yaptığımızı, nerede kaldığımızı ve sırada ne olduğunu unutmamak için tutulan **esnek yol gösterici ve takip listesidir**. Yeni bilgi, başarısız deneme veya daha basit çözüm bulunduğunda adımları, teknolojileri, sıralamayı, kontrol listesini ve kapsamı **değiştir, birleştir, kaldır veya yeniden yaz**. Plana uymak uğruna gereksiz kod, katman, süreç, test veya bekleme üretme. Her değişiklikte kısaca **nedenini ve mevcut durumu** güncelle; eskisini sessizce doğruymuş gibi bırakma.

## 1. Hedef ve tercih edilen başlangıç yaklaşımı

- **Ana uygulama dili: Python 3.** İlk masaüstü arayüzü adayı **PySide6 / Qt Widgets**. Ayrı HTML/port üzerinden sunulan Control Center'ı WebView'e sarmak, gerçek masaüstü uygulaması sayılmayacak. Qt'nin bütün widget'larının OS'nin birebir yerel kontrolleri olduğu da iddia edilmeyecek.
- Windows **x64/ARM64** ve macOS **x64/ARM64**: Kullanıcı açısından **aynı özellikler, aynı tasarım ve aynı davranış**. Aynı ürün kaynağından dört hedefe dağıtım; ayrı platform ürünleri değil.
- Masaüstü UI, MCP/yerel API, Browser Native Messaging host, Telegram/Task/Auto Continue, dosya/terminal/işlem yönetimi, gözlemlenebilirlik, kurulum/güncelleme ve geri alma **tek Python çekirdeği** etrafında tasarlanır. Masaüstü UI ve agent runtime gerekirse güvenlik/çökme izolasyonu için *az sayıda* ayrı süreç olabilir; ayrı iş mantığı olmaz.
- **Tek ortak güncelleme/rollback motoru:** indirme → imza/hash doğrulama → ayrı sürüm dizinine kurulum → atomik etkinleştirme → gerçek sağlık → tamamla / eski sağlıklı sürüme dön. macOS ve Windows için farklı güncelleme *ürünleri* veya farklı karar akışları yazılmayacak. Platformun zorunlu tuttuğu servis, süreç, izin, atomik dosya taşıma ve kilit davranışı **küçük Python OS adaptörlerinde** kalır. 'Tamamı aynı OS çağrılarıyla yürür' gibi gerçek dışı garanti verilmez.
- **Tek açık istisna:** Chrome uzantısının çalıştırılan kodu JavaScript olmak zorunda. Chrome Web Store'daki uzantı ayrı dağıtılmaya devam eder. Var olan Peekaboo/winapp veya sistem araçları **haricî bağımlılık** olarak gerekirse kullanılabilir; Equinox Local'in ana kodunu ikinci/üçüncü dilde yeniden yazmayı varsayma.
- Python dahil gereken runtime ve kütüphaneler ürüne paketlenir; son kullanıcıya Python, pip, compiler, Git vb. kurma şartı getirilmez. Qt/PySide6'nın **AGPLv3 ile birlikte dağıtım ve LGPLv3 yükümlülükleri**, ticari lisans ihtiyacı doğurmadan, ürünün seçilen modülleri/paketleme yöntemi üzerinden kontrol edilir. Windows ARM64 dahil gerçek bağımsız paketleme ve native köprü uyumluluğu *kanıtlanmış değil*; destek varsayımıyla yayın yapılmaz.
- **Güvenlikten ödün verme veya gereksiz güvenlik altyapısı icat etme yok:** loopback-only mutasyon API, explicit tarayıcı bağlamı, erişim yetkileri, sistem izinleri, özel durum dosyaları/kimlik bilgileri, OS süreç sahipliği, imzalı güncellemeler, rollback ve kullanıcı verisi korunur. Mevcut karmaşık uygulama parçaları aynen taşınmaz.

## 2. Kapsamın sınırları

- Eski çalışan Equinox Local, yeni sürüm gerçekten eşdeğer ve güvenilir olana dek kullanıcılar için **mevcut çalışır ürün** olarak kalır. Eski kodu veya kullanıcı verisini silme, mevcut Windows kurulumuna güncelleme uygulatma, Mac mini'nin **özel factory Developer** profilini public Stable'a çevirme.
- Açık **Windows native Main updater PR #230**, yeni mimari planıyla **karıştırılmaz**: eksik üretim/rollback ve gerçek native sağlık kanıtı olmayan bu işi tamamlanmış sayma; bu plan kendi başına onun merge/release izni değildir. Eski güncelleme sorunları #184/#186 açık kalabilir. Hangi eski işleri kapatacağımız, yeni sürümün gerçek çalışan karşılığı kanıtlanınca kararlaştırılır.
- Factory ve public ürün kaynaklarının sınırları, AGPL lisansı, mevcut profil/anahtarlar, Telegram eşleme ve Task Capsule geçmişi, Equinox Browser'ın Agent/Your Browser izolasyonu, izin politikaları korunacak. Geçiş sonunda yerinde veri migrasyonu + geri dönüş açıkça ele alınacak.
- Kodun her satırının Python olması hedefi **Chrome/sistem dış araçları/derlenmiş üçüncü taraf kütüphaneler** için geçerli değildir. Yeni kendi ürünü için mümkün olduğunca tek kaynak dili kullanırız.

## 3. Esnek çalışma sırası ve ilerleme tablosu

Liste **önerilen sıra**dır; sabit aşama kapıları değildir. Her büyük adımdan sonra kalan işleri yeniden değerlendir; gereksiz alt görevlerle tur harcama. Testler bir teslimatı doğrular, teslimatın yerine geçmez.

| Alan | Durum | Görülebilir tamamlanma işareti |
|---|---|---|
| A. Mevcut özellik/veri sözleşmesini çıkar | Bekliyor | Kullanıcı açısından korunacak özellikler, ayarlar, izinler, dosya biçimleri ve Browser protokolü kısa envanter |
| B. Sade Python uygulama iskeleti | Bekliyor | WebView'sız gerçek Qt masaüstü penceresi + ortak local runtime; gerçek macOS/Windows üzerinde açılıp kapanır |
| C. Ortak kurulum ve güncelleme çekirdeği | Bekliyor | Dört hedefte aynı akışla A→B, B'nin gerçek sağlığı ve başarısız B→sağlıklı A; tek kullanıcı eylemi, kullanıcı verisi korunur |
| D. Browser/MCP dikey entegrasyonu | Bekliyor | Chrome uzantısı ↔ Python Native Messaging ↔ MCP ↔ masaüstü arayüzü; Agent/Your Browser bağlam sınırları korunur |
| E. Temel yetenekleri aktar | Bekliyor | Terminal/dosyalar/projeler, Tool API, izinler, Control Center, tanılama; aynı yetenekler iki OS ailesinde |
| F. Görev/entegrasyon/otomasyon | Bekliyor | Telegram, Task Capsule, Auto Continue, Peekaboo/winapp işlev eşdeğerliği; geçerli oturum/izin politikaları korunur |
| G. Eski kurulumdan geçiş | Bekliyor | Gerçek eski Stable/Developer profillerinden kontrollü migrasyon ve başarısızlıkta geri dönüş; şifreler/geçmiş korunur |
| H. Ürün kabulü ve kontrollü yayın | Bekliyor | Windows x64/ARM64 + macOS x64/ARM64 üzerinde kullanıcıya görünen tam akış ve güvenli güncelleme/rollback kanıtları |

**Not:** Önce küçük **uçtan uca çalışan ürün akışı** ortaya çıkar; ayrı ayrı yüzlerce sözde hazır modül üretip en son bağlamaya çalışma. Gerekirse C ile D'nin sırası/birlikte geliştirilmesi değişir. Kullanıcıya çalışan davranışı göstermeyen sahte fixture başarıları 'tamamlandı' sayılmaz. Projenin bütün özelliklerini tamamlamadan üretimde eski kurulumlar değiştirilmez.

## 4. Başlamadan / ilerlerken karar verilecek konular

Bunlar ayrı bir araştırma projesi açma gerekçesi değil; ilgili gerçek iş yapılırken kısa ve somut biçimde sonuçlandırılacak **açık sorulardır**.

- Python ve PySide6'nın **dört mimari** için seçilecek bağımsız paketleme aracı, imzalama/işletim sistemi izinleri ve modül/lisans uyumu; özellikle Windows ARM64 native bağımlılıklar.
- macOS Accessibility/Screen Recording için kullanıcıya kalıcı ve doğru uygulama kimliğiyle OS izni; Windows UI Automation için mevcut winapp/ilgili araçların korunması. Kullanıcı aynı yetenekleri görmeli; OS'de olmayan kabiliyet uydurulamaz.
- Tek güncelleyicinin çalışan uygulama dosyalarını değiştiremeyeceği durumlarda en az hangi *bağımsız* updater/launcher süreci gerekir; süreç sahipliği, kilit, disk kesintisi ve geri alma nasıl **en az karmaşıklıkla** sağlanır?
- Devam eden önceki işleri bırakma / yeni sisteme taşıma: özellikle Windows Stable6.0.4 kullanıcısının eski `rollback_failed` durumu, açık PR #230 ve public Main snapshot. Gerçek cihazlar, fabrika private profil ve imzalı eski sürümler korunur.

## 5. Takip ve değişiklik günlüğü

Bu bölüm **unutmama defteri**. Bir tur bittiğinde uzun teknik destan değil, aşağıdaki dört bilgi güncellenecek:

1. **Biten:** Gerçekte ne çalışıyor, hangi OS / kurulumda görüldü? (Yerel test ile gerçek kurulum kanıtını ayır.)
2. **Şu an:** Aktif alan ve blocker; açık kalan kritik risk.
3. **Sonraki:** Bir sonraki turda yapılacak *tek en değerli* somut iş.
4. **Değişen karar:** Planın neyi, neden değişti? Eski kararı artık kesin şartmış gibi tekrarlama.

| Tarih | Biten / karar | Sıradaki adım |
|---|---|---|
| 2026-10-13 | Python 3 + PySide6 / Qt Widgets ilk teknoloji tercihi; **yalnız yol haritası kaydedildi, yeniden yazıma başlanmadı**. Plan bağlayıcı değil; eski ürün ve PR #230 korunuyor. | Önce özellik/veri sınırlarının kısa envanteri, ardından mümkün olan en küçük *gerçek çalışan* yeni ürün dikey akışı. |

**Son ilke:** Kullanıcı planı değil, çalışan Equinox Local'i istiyor. Bu dosya gerekirse tamamen değişebilir; çalışan eski ürünü riske atarak plana sadakat gösterilemez.
