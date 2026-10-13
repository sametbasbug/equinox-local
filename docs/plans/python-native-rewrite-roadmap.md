# Equinox Local — Python tabanlı gerçek masaüstü yeniden yazım yol haritası

**Durum:** Yalnızca plan / çalışma takibi. Uygulama başlamadı. 2026-10-13.

> **BU DOSYA KANUN DEĞİLDİR.** Bu belge teknik şartname, bağlayıcı tasarım kararı, değiştirilemez görev sırası, otomatik çalışma izni veya yayın onayı **değildir**. Yalnızca neyi amaçladığımızı, ne yaptığımızı, nerede kaldığımızı ve sırada ne olduğunu unutmamak için tutulan **esnek yol gösterici ve takip listesidir**. Yeni bilgi, başarısız deneme veya daha basit çözüm bulunduğunda adımları, teknolojileri, sıralamayı, kontrol listesini ve kapsamı **değiştir, birleştir, kaldır veya yeniden yaz**. Plana uymak uğruna gereksiz kod, katman, süreç, test veya bekleme üretme. Her değişiklikte kısaca **nedenini ve mevcut durumu** güncelle; eskisini sessizce doğruymuş gibi bırakma.

## 1. Hedef ve tercih edilen başlangıç yaklaşımı

- **Ana uygulama dili: Python 3.** İlk masaüstü arayüzü adayı **PySide6 / Qt Widgets**. Ayrı HTML/port üzerinden sunulan Control Center'ı WebView'e sarmak, gerçek masaüstü uygulaması sayılmayacak. Qt'nin bütün widget'larının OS'nin birebir yerel kontrolleri olduğu da iddia edilmeyecek.
- Windows **x64/ARM64** ve macOS **x64/ARM64**: Kullanıcı açısından **aynı özellikler, aynı tasarım ve aynı davranış**. Aynı ürün kaynağından dört hedefe dağıtım; ayrı platform ürünleri değil.
- **TEK MAIN, TEK ÜRÜN, TEK KULLANICI DENEYİMİ.** Yeni Equinox Local'de **factory repo YOK, factory profili YOK, factory sürümü YOK, Developer sürümü/kanalı YOK, Stable/Main arasında kanal seçimi YOK**. Projeyi geliştiren kişi de indiren kullanıcı da **aynı Equinox Local uygulamasını ve aynı Main güncelleme kanalını** kullanır. Contributor'ın bir Git branch'inde kendi değişikliğini yerel çalıştırması yeni sürüm/profil/kanal yaratmaz. Platforma özel derlenen paketler, ayrı ürün sürümü değil aynı kabul edilmiş Main kaynak commit'inin çıktılarıdır.
- Masaüstü UI, MCP/yerel API, Browser Native Messaging host, Telegram/Task/Auto Continue, dosya/terminal/işlem yönetimi, gözlemlenebilirlik, kurulum/güncelleme ve geri alma **tek Python çekirdeği** etrafında tasarlanır. Masaüstü UI ve agent runtime gerekirse güvenlik/çökme izolasyonu için *az sayıda* ayrı süreç olabilir; ayrı iş mantığı olmaz.
- **Tek ortak güncelleme/rollback motoru:** indirme → imza/hash doğrulama → ayrı sürüm dizinine kurulum → atomik etkinleştirme → gerçek sağlık → tamamla / eski sağlıklı sürüme dön. macOS ve Windows için farklı güncelleme *ürünleri* veya farklı karar akışları yazılmayacak. Platformun zorunlu tuttuğu servis, süreç, izin, atomik dosya taşıma ve kilit davranışı **küçük Python OS adaptörlerinde** kalır. 'Tamamı aynı OS çağrılarıyla yürür' gibi gerçek dışı garanti verilmez.
- **Tek açık istisna:** Chrome uzantısının çalıştırılan kodu JavaScript olmak zorunda. Chrome Web Store'daki uzantı ayrı dağıtılmaya devam eder. Var olan Peekaboo/winapp veya sistem araçları **haricî bağımlılık** olarak gerekirse kullanılabilir; Equinox Local'in ana kodunu ikinci/üçüncü dilde yeniden yazmayı varsayma.
- Python dahil gereken runtime ve kütüphaneler ürüne paketlenir; son kullanıcıya Python, pip, compiler, Git vb. kurma şartı getirilmez. Qt/PySide6'nın **AGPLv3 ile birlikte dağıtım ve LGPLv3 yükümlülükleri**, ticari lisans ihtiyacı doğurmadan, ürünün seçilen modülleri/paketleme yöntemi üzerinden kontrol edilir. Windows ARM64 dahil gerçek bağımsız paketleme ve native köprü uyumluluğu *kanıtlanmış değil*; destek varsayımıyla yayın yapılmaz.
- **Güvenlikten ödün verme veya gereksiz güvenlik altyapısı icat etme yok:** loopback-only mutasyon API, explicit tarayıcı bağlamı, erişim yetkileri, sistem izinleri, özel durum dosyaları/kimlik bilgileri, OS süreç sahipliği, imzalı güncellemeler, rollback ve kullanıcı verisi korunur. Mevcut karmaşık uygulama parçaları aynen taşınmaz.

## 2. Hızlı güncelleme, her cihazdan katkı ve tek Main ürünü

Bu üç özellik önceki Equinox Local'den **korunacak kullanıcı beklentileridir**. Aşağıdaki teknik uygulama sadece **öneridir**; bu dosya yine kanun değildir. Daha basit veya güvenli çözüm bulunursa değiştir:

- **Hızlı geliştirme ve yerinde güncelleme:** Geliştirici Python checkout'undaki değişikliği hızlı yeniden yükleme/restart ile görür; her küçük kod değişikliği için macOS/Windows tam native uygulama paketleri üretilmez. Son kullanıcı yeni sürümü yeniden kurulum/ayar kaybı olmadan, **tek ortak Python güncelleme motoru** aracılığıyla alır. Kaynak kod/görsel gibi saf Python değişiklikleri ile Python interpreter/Qt/native kütüphane değişiklikleri ayrıştırılabilir. Öneri: seyrek güncellenen, platforma göre paketlenen uygulama host'u + kurulumdan ayrı, doğrulanmış ve versiyonlanmış saf-Python kaynak yükleri. Kaynak güncellemesi sağlam SHA/imza doğrulamasını, gerçek sağlık kontrolünü ve rollback'i atlayamaz. Her değişikliğin CI kontrolü bitmeden 'anında' yayınlanacağı iddia edilmez; doküman değişikliği kullanıcı güncellemesi olmaz.
- **Her cihazdan geliştirme / kolay katkı:** Bir kullanıcı veya contributor **aynı public repoyu clone/fork eder, değişikliği yapar, yerel çalıştırır, PR açar**. Kendi bilgisayarında uygulama geliştirmek için özel factory rolü, farklı binary, gizli repo, özel API anahtarı, signing key veya ikinci ürüne geçmek gerekmez. Geliştirici ve kullanıcı **aynı Main programını** kullanır; sadece contributor bir Git çalışma ağacında henüz yayımlanmamış kodunu doğal olarak deneyebilir. Geliştirme için ayrı checkout/virtualenv izolasyonu ürün profili veya kanal farkı değildir; kurulu kullanıcı verisine dokunmamalıdır. Ortak Python CLI ve basit geliştirme komutları macOS/Windows x64/ARM64'te geçerli olmalı.
- **Factory kavramının tamamen kaldırılması:** Yeni Equinox Local'de factory için **ayrı repo, sürüm, profil, kurulum, gizli kod katmanı veya ayrı release hattı oluşturulmaz**. Eski özel factory reposuna bağımlı genel ürün, CI, release ve paketleme araçları tek public ana repoya taşınır; eski repo **yeni ürünün parçası değildir** ve geçişten sonra gerekli olmayacaktır. Gizli materyal (imzalama anahtarı, erişim token'ı, özel hesap ayarı) repoya girmez; gereken sırlar normal yerel OS güvenli deposu veya CI secret olarak durur. **Bu bir factory profili anlamına gelmez**; bütün kullanıcılar normal ürünle kendi hesap/izinlerini kullanır.
- **Tek Main yayın hattı:** Katkılar normal fork/branch → PR → gereken kalite kontrolleri → `main` akışıyla ilerler. Dört platformun paketleri aynı kabul edilen Main commit'inden hazırlanır ve tek **Main güncelleme** akışıyla herkese sunulur. Yayınlanmamış PR'lar kullanıcıya otomatik kurulmaz. Doküman değişiklikleri uygulama güncellemesi üretmez. `Stable`, `Developer`, `Factory`, `Beta` gibi ikinci bir **devamlı ürün güncelleme kanalı** oluşturulmaz; eski kurulumdan bir kereye mahsus geçiş için gerekebilecek uyumluluk paketi yeni kanal sayılmaz.

**Önemli teknik sınır:** macOS'ta imzalı `.app`, Windows'ta kurulu host ve çalışan Python/native kütüphaneleri her zaman yerinde değiştirilemez. Ortak güncelleme motorunun küçük OS adaptörleri bu zorunlu farkları yönetir. Platformlara ayrı ikinci güncelleme motoru yazılmaz. İlk tercih olan kaynak/host ayrımı fazla karmaşıklık çıkarırsa **yöntem değişir**, amaçlar korunur.

## 3. Kapsamın sınırları

- Mevcut çalışan eski Equinox Local ve Mac mini'deki **eski** factory/Developer kurulumu, yeni Main ürünü gerçekten çalışıp güvenli geçiş sağlanana kadar **sadece geçici eski kurulum** olarak korunur. Bu mevcut durumu yeni ürünün tasarımına taşıma: **yeni üründe factory veya Developer profili/sürümü kesinlikle yoktur**. Eski kodu veya kullanıcı verisini silme, mevcut Windows kurulumuna riskli güncelleme uygulatma; geçişten sonra herkes aynı Main uygulamasını kullanacak.
- Açık **Windows native Main updater PR #230**, yeni mimari planıyla **karıştırılmaz**: eksik üretim/rollback ve gerçek native sağlık kanıtı olmayan bu işi tamamlanmış sayma; bu plan kendi başına onun merge/release izni değildir. Eski güncelleme sorunları #184/#186 açık kalabilir. Hangi eski işleri kapatacağımız, yeni sürümün gerçek çalışan karşılığı kanıtlanınca kararlaştırılır.
- Eski private factory altyapısından kullanıcı ayarlarının/gizli bilgilerin güvenli geçişi, AGPL lisansı, Telegram eşleme ve Task Capsule geçmişi, Equinox Browser'ın Agent/Your Browser izolasyonu ve izin politikaları korunacak. Yeni üründe hiç kimsenin farklı uygulama profiline veya ayrı kod deposuna ihtiyacı olmayacak; yerinde veri migrasyonu ve geri dönüş açıkça ele alınacak.
- Kodun her satırının Python olması hedefi **Chrome/sistem dış araçları/derlenmiş üçüncü taraf kütüphaneler** için geçerli değildir. Yeni kendi ürünü için mümkün olduğunca tek kaynak dili kullanırız.

## 4. Esnek çalışma sırası ve ilerleme tablosu

Liste **önerilen sıra**dır; sabit aşama kapıları değildir. Her büyük adımdan sonra kalan işleri yeniden değerlendir; gereksiz alt görevlerle tur harcama. Testler bir teslimatı doğrular, teslimatın yerine geçmez.

| Alan | Durum | Görülebilir tamamlanma işareti |
|---|---|---|
| A. Mevcut özellik/veri sözleşmesini çıkar | Bekliyor | Kullanıcı açısından korunacak özellikler, ayarlar, izinler, Browser protokolü ve **hızlı güncelleme/her cihazdan katkı/tek Main/factory'siz ürün** envanteri |
| B. Sade Python uygulama iskeleti | Bekliyor | WebView'sız gerçek Qt masaüstü penceresi + ortak local runtime; gerçek macOS/Windows üzerinde açılıp kapanır |
| C. Ortak kurulum ve güncelleme çekirdeği | Bekliyor | Dört hedefte aynı A→B ve rollback; kod değişiklikleri mümkün olduğunca native yeniden paketleme gerektirmez; tek kullanıcı eylemi, kullanıcı verisi korunur |
| D. Browser/MCP dikey entegrasyonu | Bekliyor | Chrome uzantısı ↔ Python Native Messaging ↔ MCP ↔ masaüstü arayüzü; Agent/Your Browser bağlam sınırları korunur |
| E. Temel yetenekleri aktar | Bekliyor | Terminal/dosyalar/projeler, Tool API, izinler, Control Center, tanılama; aynı yetenekler iki OS ailesinde |
| F. Görev/entegrasyon/otomasyon | Bekliyor | Telegram, Task Capsule, Auto Continue, Peekaboo/winapp işlev eşdeğerliği; geçerli oturum/izin politikaları korunur |
| G. Eski kurulumdan geçiş | Bekliyor | Eski Stable/factory dahil bütün kurulumlar aynı **tek Main** ürününe geçer; hiçbir kalıcı factory/Developer profili veya sürümü kalmaz, şifreler/geçmiş korunur |
| H. Ürün kabulü ve kontrollü yayın | Bekliyor | Windows x64/ARM64 + macOS x64/ARM64 üzerinde kullanıcıya görünen tam akış ve güvenli güncelleme/rollback kanıtları |

**Not:** Önce küçük **uçtan uca çalışan ürün akışı** ortaya çıkar; ayrı ayrı yüzlerce sözde hazır modül üretip en son bağlamaya çalışma. Gerekirse C ile D'nin sırası/birlikte geliştirilmesi değişir. Kullanıcıya çalışan davranışı göstermeyen sahte fixture başarıları 'tamamlandı' sayılmaz. Projenin bütün özelliklerini tamamlamadan üretimde eski kurulumlar değiştirilmez.

## 5. Başlamadan / ilerlerken karar verilecek konular

Bunlar ayrı bir araştırma projesi açma gerekçesi değil; ilgili gerçek iş yapılırken kısa ve somut biçimde sonuçlandırılacak **açık sorulardır**.

- Python ve PySide6'nın **dört mimari** için seçilecek bağımsız paketleme aracı, imzalama/işletim sistemi izinleri ve modül/lisans uyumu; özellikle Windows ARM64 native bağımlılıklar.
- macOS Accessibility/Screen Recording için kullanıcıya kalıcı ve doğru uygulama kimliğiyle OS izni; Windows UI Automation için mevcut winapp/ilgili araçların korunması. Kullanıcı aynı yetenekleri görmeli; OS'de olmayan kabiliyet uydurulamaz.
- Tek güncelleyicinin çalışan uygulama dosyalarını değiştiremeyeceği durumlarda en az hangi *bağımsız* updater/launcher süreci gerekir; süreç sahipliği, kilit, disk kesintisi ve geri alma nasıl **en az karmaşıklıkla** sağlanır?
- Hızlı saf-Python kaynak güncellemeleri ile nadir native/Qt host güncellemelerini **tek ortak imzalı güncelleyici** üzerinden yürütme; platforma özgü paketleme ve os izinleri ihmal edilmeyecek.
- Bugünkü private factory deposuna bağımlı genel paketleme/CI/ops kaynaklarının tek public repoya taşınması ve **factory repo, sürüm, profil ve kanalının yeni üründe sıfırlanması**; gizli imza ve servis anahtarları kod deposu dışında kalacak. Contributor'lar aynı ürün kodunu ve public test araçlarını çalıştırabilecek.
- Eski sistemi güvenli emekliye ayırma: Windows Stable6.0.4 kullanıcısının `rollback_failed` durumu, açık PR #230 ve mevcut `main-snapshot` geçmişi. Gerçek cihazlar ve eski kurulumlar yeni tek Main sürümüne **başarıyla** geçene kadar korunur; eski factory kurulumunun varlığı gelecekte factory profili olacağı anlamına gelmez.

## 6. Takip ve değişiklik günlüğü

Bu bölüm **unutmama defteri**. Bir tur bittiğinde uzun teknik destan değil, aşağıdaki dört bilgi güncellenecek:

1. **Biten:** Gerçekte ne çalışıyor, hangi OS / kurulumda görüldü? (Yerel test ile gerçek kurulum kanıtını ayır.)
2. **Şu an:** Aktif alan ve blocker; açık kalan kritik risk.
3. **Sonraki:** Bir sonraki turda yapılacak *tek en değerli* somut iş.
4. **Değişen karar:** Planın neyi, neden değişti? Eski kararı artık kesin şartmış gibi tekrarlama.

| Tarih | Biten / karar | Sıradaki adım |
|---|---|---|
| 2026-10-13 | Python 3 + PySide6 / Qt Widgets ilk teknoloji tercihi; **yalnız yol haritası kaydedildi, yeniden yazıma başlanmadı**. Plan bağlayıcı değil; eski ürün ve PR #230 korunuyor. | Önce özellik/veri sınırlarının kısa envanteri, ardından mümkün olan en küçük *gerçek çalışan* yeni ürün dikey akışı. |
| 2026-10-13 | İlk not: hızlı yerinde kod güncellemesi, her cihazdan katkı ve factory repo ihtiyacını kaldırma. **Sonradan düzeltilen hata:** factory'nin Developer profili olarak sürdürülmesi önerisi reddedildi. Bu eski fikir artık geçerli değil. | Tek Main ürünü için katkı ve güncelleme akışını tasarla; factory profili ekleme. |
| 2026-10-13 | **Kullanıcının kesinleştirdiği hedef:** Tek public kod deposu, tek Equinox Local uygulaması, tek Main kanalı; geliştirici ve kullanıcıya aynı sürüm/deneyim. **Factory repo/profil/sürüm/kanal yok.** Git branch ve PR yalnızca katkı iş akışı, ayrı program veya güncelleme kanalı değil. Eski factory yalnızca tamamlanacak geçişe kadar korunacak miras kurulum. | Katkı sürecini clone/fork → kod → yerel dene → PR biçiminde kolay tut; normal kullanıcıya ayrı developer kurulumu dayatma. |

**Son ilke:** Kullanıcı planı değil, çalışan Equinox Local'i istiyor. Bu dosya gerekirse tamamen değişebilir; çalışan eski ürünü riske atarak plana sadakat gösterilemez.
