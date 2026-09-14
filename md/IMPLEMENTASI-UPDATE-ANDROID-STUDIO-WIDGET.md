# Panduan Implementasi Update KaslyAI Android Studio & Widget

Dokumen ini berisi kode lengkap dan panduan langkah demi langkah untuk menerapkan 4 pembaruan pada project **Android Studio (`KaslyAI`)**:

1. **Perbaikan Status Bar** (Tampilan tidak lagi overlap dengan jam/baterai, status bar berwarna Teal `#0D6B5E`).
2. **Preview Widget di Menu Pilihan Widget** (Mengganti ikon "K" default dengan preview layout asli).
3. **Perekaman Audio dengan Countdown Timer 30 Detik** (Mencegah bug rekaman hilang/timeout & memberi indikator visual).
4. **Bottom Action Bar pada Widget "Transaksi Hari Ini"** (Menyatukan tombol Mic, Tulis, Foto [Kamera/Galeri], dan Cepat AI di bawah daftar 4 transaksi).

---

## 1. Perbaikan Status Bar (Menghilangkan Overlap)

### File: `app/src/main/res/values/themes.xml`
```xml
<resources xmlns:tools="http://schemas.android.com/tools">
    <!-- Base application theme. -->
    <style name="Theme.KaslyAI" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <!-- Warna Utama -->
        <item name="colorPrimary">#0D6B5E</item>
        <item name="colorPrimaryVariant">#094E44</item>
        <item name="colorOnPrimary">#FFFFFF</item>
        
        <!-- Status Bar -->
        <item name="android:statusBarColor">#0D6B5E</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:fitsSystemWindows">true</item>
    </style>
</resources>
```

### File: `app/src/main/java/com/kaslyai/app/MainActivity.kt`
Pastikan di method `onCreate`, Window Insets diatur agar konten WebView tidak menggambar di bawah status bar:
```kotlin
package com.kaslyai.app

import android.graphics.Color
import android.os.Bundle
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 1. Konten TIDAK masuk ke bawah status bar (fits system windows)
        WindowCompat.setDecorFitsSystemWindows(window, true)

        // 2. Set warna status bar menjadi Teal (#0D6B5E)
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
        window.statusBarColor = Color.parseColor("#0D6B5E")

        // 3. Pastikan teks & ikon jam/baterai berwarna PUTIH
        val insetsController = WindowCompat.getInsetsController(window, window.decorView)
        insetsController.isAppearanceLightStatusBars = false

        setContentView(R.layout.activity_main)

        // Setup WebView dan logika lainnya...
    }
}
```

---

## 2. Preview Widget di Launcher (`android:previewLayout`)

Agar widget tidak hanya menampilkan huruf "K" hijau di tray pemilih widget Android, tambahkan `android:previewLayout` ke masing-masing XML info widget.

### File: `app/src/main/res/xml/widget_transaksi_info.xml`
```xml
<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="280dp"
    android:minHeight="180dp"
    android:targetCellWidth="4"
    android:targetCellHeight="3"
    android:updatePeriodMillis="1800000"
    android:initialLayout="@layout/widget_transaksi_hari_ini"
    android:previewLayout="@layout/widget_transaksi_hari_ini"
    android:resizeMode="horizontal|vertical"
    android:widgetCategory="home_screen"
    android:description="@string/desc_widget_transaksi" />
```

### File: `app/src/main/res/xml/widget_saldo_info.xml`
```xml
<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="280dp"
    android:minHeight="110dp"
    android:targetCellWidth="4"
    android:targetCellHeight="2"
    android:updatePeriodMillis="1800000"
    android:initialLayout="@layout/widget_saldo_dompet"
    android:previewLayout="@layout/widget_saldo_dompet"
    android:resizeMode="horizontal|vertical"
    android:widgetCategory="home_screen"
    android:description="@string/desc_widget_saldo" />
```

---

## 3. Audio Widget dengan Countdown Timer 30 Detik

Membatasi perekaman maksimal 30 detik mencegah payload audio meledak dan memicu timeout, serta memberi panduan visual kepada pengguna saat berbicara.

### File: `app/src/main/res/layout/activity_audio_record_overlay.xml`
```xml
<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="#80000000">

    <LinearLayout
        android:layout_width="280dp"
        android:layout_height="wrap_content"
        android:layout_gravity="center"
        android:background="@drawable/bg_dialog_rounded"
        android:gravity="center"
        android:orientation="vertical"
        android:padding="24dp">

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="Mendengarkan..."
            android:textColor="#1F2937"
            android:textSize="16sp"
            android:textStyle="bold" />

        <TextView
            android:id="@+id/tv_countdown"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginTop="8dp"
            android:text="00:30"
            android:textColor="#0D6B5E"
            android:textSize="28sp"
            android:textStyle="bold" />

        <ProgressBar
            android:id="@+id/progress_timer"
            style="?android:attr/progressBarStyleHorizontal"
            android:layout_width="match_parent"
            android:layout_height="6dp"
            android:layout_marginTop="12dp"
            android:max="30"
            android:progress="30"
            android:progressTint="#0D6B5E" />

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginTop="10dp"
            android:gravity="center"
            android:text="Sebutkan pengeluaran/pemasukan Anda\n(misal: Makan siang 25rb pakai Cash)"
            android:textColor="#6B7280"
            android:textSize="12sp" />

        <Button
            android:id="@+id/btn_stop_recording"
            android:layout_width="match_parent"
            android:layout_height="44dp"
            android:layout_marginTop="18dp"
            android:backgroundTint="#0D6B5E"
            android:text="Selesai &amp; Kirim"
            android:textColor="#FFFFFF"
            android:textStyle="bold" />
    </LinearLayout>
</FrameLayout>
```

### File: `app/src/main/java/com/kaslyai/app/widget/AudioRecordActivity.kt`
```kotlin
package com.kaslyai.app.widget

import android.app.Activity
import android.media.MediaRecorder
import android.os.Bundle
import android.os.CountDownTimer
import android.util.Base64
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import com.kaslyai.app.R
import java.io.File
import java.io.FileInputStream

class AudioRecordActivity : Activity() {

    private var mediaRecorder: MediaRecorder? = null
    private var audioFile: File? = null
    private var countDownTimer: CountDownTimer? = null
    private val MAX_SECONDS = 30L

    private lateinit var tvCountdown: TextView
    private lateinit var progressTimer: ProgressBar
    private lateinit var btnStop: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_audio_record_overlay)

        tvCountdown = findViewById(R.id.tv_countdown)
        progressTimer = findViewById(R.id.progress_timer)
        btnStop = findViewById(R.id.btn_stop_recording)

        btnStop.setOnClickListener {
            finishAndProcessAudio()
        }

        startRecording()
    }

    private fun startRecording() {
        try {
            audioFile = File(cacheDir, "widget_voice_${System.currentTimeMillis()}.m4a")
            mediaRecorder = MediaRecorder().apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioEncodingBitRate(64000)
                setAudioSamplingRate(44100)
                setOutputFile(audioFile?.absolutePath)
                prepare()
                start()
            }

            countDownTimer = object : CountDownTimer(MAX_SECONDS * 1000, 1000) {
                override fun onTick(millisUntilFinished: Long) {
                    val sec = millisUntilFinished / 1000
                    tvCountdown.text = String.format("00:%02d", sec)
                    progressTimer.progress = sec.toInt()
                }

                override fun onFinish() {
                    tvCountdown.text = "00:00"
                    progressTimer.progress = 0
                    finishAndProcessAudio()
                }
            }.start()

        } catch (e: Exception) {
            Toast.makeText(this, "Gagal merekam: ${e.message}", Toast.LENGTH_SHORT).show()
            finish()
        }
    }

    private fun finishAndProcessAudio() {
        countDownTimer?.cancel()
        try {
            mediaRecorder?.apply {
                stop()
                release()
            }
            mediaRecorder = null

            audioFile?.let { file ->
                if (file.exists() && file.length() > 0) {
                    val bytes = FileInputStream(file).readBytes()
                    val base64Audio = Base64.encodeToString(bytes, Base64.NO_WRAP)
                    
                    // Kirim ke Bridge / Headless WebView untuk analisis AI
                    KaslyAiBridgeService.sendAudioToGemini(this, base64Audio, "audio/m4a")
                    Toast.makeText(this, "Audio sedang diproses KaslyAI...", Toast.LENGTH_SHORT).show()
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        } finally {
            finish()
        }
    }

    override fun onDestroy() {
        countDownTimer?.cancel()
        mediaRecorder?.release()
        mediaRecorder = null
        super.onDestroy()
    }
}
```

---

## 4. Bottom Action Bar pada Widget "Transaksi Hari Ini"

### File: `app/src/main/res/layout/widget_transaksi_hari_ini.xml`
```xml
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@drawable/bg_widget_card"
    android:orientation="vertical"
    android:padding="14dp">

    <!-- 1. Header: Judul, Tanggal & Refresh -->
    <RelativeLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content">

        <TextView
            android:id="@+id/tv_widget_title"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="Transaksi Hari Ini"
            android:textColor="#111827"
            android:textSize="15sp"
            android:textStyle="bold" />

        <LinearLayout
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_alignParentEnd="true"
            android:gravity="center_vertical"
            android:orientation="horizontal">

            <TextView
                android:id="@+id/tv_widget_date"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="Hari Ini"
                android:textColor="#6B7280"
                android:textSize="12sp" />

            <ImageView
                android:id="@+id/btn_widget_refresh"
                android:layout_width="20dp"
                android:layout_height="20dp"
                android:layout_marginStart="8dp"
                android:src="@drawable/ic_refresh" />
        </LinearLayout>
    </RelativeLayout>

    <!-- 2. Ringkasan: Saldo & Pengeluaran -->
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="8dp"
        android:orientation="horizontal">

        <!-- Card Saldo -->
        <LinearLayout
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_marginEnd="4dp"
            android:layout_weight="1"
            android:background="@drawable/bg_summary_green"
            android:orientation="vertical"
            android:padding="8dp">

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="Saldo Dompet"
                android:textColor="#0D6B5E"
                android:textSize="11sp"
                android:textStyle="bold" />

            <TextView
                android:id="@+id/tv_summary_saldo"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:layout_marginTop="2dp"
                android:text="Rp 0"
                android:textColor="#0D6B5E"
                android:textSize="13sp"
                android:textStyle="bold" />
        </LinearLayout>

        <!-- Card Pengeluaran -->
        <LinearLayout
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_marginStart="4dp"
            android:layout_weight="1"
            android:background="@drawable/bg_summary_red"
            android:orientation="vertical"
            android:padding="8dp">

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="Pengeluaran"
                android:textColor="#DC2626"
                android:textSize="11sp"
                android:textStyle="bold" />

            <TextView
                android:id="@+id/tv_summary_pengeluaran"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:layout_marginTop="2dp"
                android:text="Rp 0"
                android:textColor="#DC2626"
                android:textSize="13sp"
                android:textStyle="bold" />
        </LinearLayout>
    </LinearLayout>

    <!-- 3. List 4 Transaksi Hari Ini (Scrollable) -->
    <ListView
        android:id="@+id/lv_widget_transaksi"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_marginTop="8dp"
        android:layout_weight="1"
        android:divider="@android:color/transparent"
        android:dividerHeight="6dp"
        android:scrollbars="vertical" />

    <!-- 4. BOTTOM ACTION BAR: MIC, TULIS, FOTO, CEPAT AI -->
    <LinearLayout
        android:id="@+id/layout_bottom_actions"
        android:layout_width="match_parent"
        android:layout_height="44dp"
        android:layout_marginTop="8dp"
        android:background="@drawable/bg_bottom_action_bar"
        android:gravity="center_vertical"
        android:orientation="horizontal"
        android:paddingStart="8dp"
        android:paddingEnd="8dp">

        <!-- Tombol Mic -->
        <ImageView
            android:id="@+id/btn_action_mic"
            android:layout_width="34dp"
            android:layout_height="34dp"
            android:background="@drawable/bg_circle_button_soft"
            android:padding="7dp"
            android:src="@drawable/ic_mic_teal" />

        <!-- Tombol Tulis -->
        <ImageView
            android:id="@+id/btn_action_write"
            android:layout_width="34dp"
            android:layout_height="34dp"
            android:layout_marginStart="8dp"
            android:background="@drawable/bg_circle_button_soft"
            android:padding="7dp"
            android:src="@drawable/ic_edit_text" />

        <!-- Tombol Foto -->
        <ImageView
            android:id="@+id/btn_action_photo"
            android:layout_width="34dp"
            android:layout_height="34dp"
            android:layout_marginStart="8dp"
            android:background="@drawable/bg_circle_button_soft"
            android:padding="7dp"
            android:src="@drawable/ic_camera" />

        <View
            android:layout_width="0dp"
            android:layout_height="1dp"
            android:layout_weight="1" />

        <!-- Tombol Transaksi Cepat AI -->
        <LinearLayout
            android:id="@+id/btn_action_quick_ai"
            android:layout_width="wrap_content"
            android:layout_height="32dp"
            android:background="@drawable/bg_pill_button_teal"
            android:gravity="center_vertical"
            android:paddingStart="10dp"
            android:paddingEnd="10dp">

            <ImageView
                android:layout_width="14dp"
                android:layout_height="14dp"
                android:src="@drawable/ic_sparkle_white" />

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:layout_marginStart="5dp"
                android:text="Cepat AI"
                android:textColor="#FFFFFF"
                android:textSize="12sp"
                android:textStyle="bold" />
        </LinearLayout>
    </LinearLayout>

</LinearLayout>
```

---

## 5. PhotoChoiceActivity (Pilihan Galeri / Kamera)

Saat tombol Foto di widget diklik, Activity transparan ini muncul memberi pilihan Kamera atau Galeri:

### File: `app/src/main/java/com/kaslyai/app/widget/PhotoChoiceActivity.kt`
```kotlin
package com.kaslyai.app.widget

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.util.Base64
import android.widget.Toast
import java.io.ByteArrayOutputStream

class PhotoChoiceActivity : Activity() {

    private val REQ_CAMERA = 101
    private val REQ_GALLERY = 102

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val options = arrayOf("📷 Ambil Foto (Kamera)", "🖼️ Pilih dari Galeri")
        AlertDialog.Builder(this)
            .setTitle("Tambah Transaksi via Foto")
            .setItems(options) { _, which ->
                when (which) {
                    0 -> openCamera()
                    1 -> openGallery()
                }
            }
            .setOnCancelListener { finish() }
            .setOnDismissListener { /* diselesaikan setelah intent kembali */ }
            .show()
    }

    private fun openCamera() {
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        startActivityForResult(intent, REQ_CAMERA)
    }

    private fun openGallery() {
        val intent = Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI)
        startActivityForResult(intent, REQ_GALLERY)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode == RESULT_OK) {
            var bitmap: Bitmap? = null
            if (requestCode == REQ_CAMERA) {
                bitmap = data?.extras?.get("data") as? Bitmap
            } else if (requestCode == REQ_GALLERY) {
                val imageUri: Uri? = data?.data
                imageUri?.let { uri ->
                    val stream = contentResolver.openInputStream(uri)
                    bitmap = BitmapFactory.decodeStream(stream)
                }
            }

            bitmap?.let { bmp ->
                val outputStream = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.JPEG, 80, outputStream)
                val base64Img = Base64.encodeToString(outputStream.toByteArray(), Base64.NO_WRAP)
                
                // Kirim ke Bridge / Headless WebView untuk analisis AI
                KaslyAiBridgeService.sendImageToGemini(this, base64Img, "image/jpeg")
                Toast.makeText(this, "Foto sedang dianalisis KaslyAI...", Toast.LENGTH_SHORT).show()
            }
        }
        finish()
    }
}
```

---

## 6. Binding Tombol di `TransaksiWidgetProvider.kt`

Hubungkan tombol-tombol action bar ke `PendingIntent`:

```kotlin
// 1. Tombol Mic -> Buka AudioRecordActivity dengan countdown
val micIntent = Intent(context, AudioRecordActivity::class.java)
val micPendingIntent = PendingIntent.getActivity(
    context, 201, micIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
)
views.setOnClickPendingIntent(R.id.btn_action_mic, micPendingIntent)

// 2. Tombol Tulis -> Buka QuickTextActivity / modal tambah transaksi
val writeIntent = Intent(context, MainActivity::class.java).apply {
    action = "ACTION_OPEN_MANUAL_ADD"
}
val writePendingIntent = PendingIntent.getActivity(
    context, 202, writeIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
)
views.setOnClickPendingIntent(R.id.btn_action_write, writePendingIntent)

// 3. Tombol Foto -> Buka PhotoChoiceActivity (Kamera / Galeri)
val photoIntent = Intent(context, PhotoChoiceActivity::class.java)
val photoPendingIntent = PendingIntent.getActivity(
    context, 203, photoIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
)
views.setOnClickPendingIntent(R.id.btn_action_photo, photoPendingIntent)

// 4. Tombol Transaksi Cepat AI -> Buka Shortcut Cepat AI
val quickAiIntent = Intent(context, MainActivity::class.java).apply {
    action = "ACTION_OPEN_AI_SCAN"
}
val quickAiPendingIntent = PendingIntent.getActivity(
    context, 204, quickAiIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
)
views.setOnClickPendingIntent(R.id.btn_action_quick_ai, quickAiPendingIntent)
```

---

## 7. Daftarkan Activity Baru di `AndroidManifest.xml`

```xml
<!-- Activity Audio Record dengan Overlay Transparan -->
<activity
    android:name=".widget.AudioRecordActivity"
    android:theme="@android:style/Theme.Translucent.NoTitleBar"
    android:exported="false" />

<!-- Activity Pilihan Foto Kamera / Galeri -->
<activity
    android:name=".widget.PhotoChoiceActivity"
    android:theme="@android:style/Theme.Translucent.NoTitleBar"
    android:exported="false" />
```
