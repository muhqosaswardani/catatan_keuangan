
[Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime] | Out-Null
 = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
 = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
foreach ( in ) {
    Write-Output (.DisplayName + ' | ' + .Language + ' | ' + .Gender)
}
