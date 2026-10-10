@echo off
REM Konfigurasi pagefile eksplisit: 2048-8192 MB di drive C:.
REM Tanpa pagefile, Windows tidak bisa membuat proses baru saat RAM penuh —
REM inilah penyebab laptop hang / OutOfMemoryException saat menjalankan test.
wmic computersystem set AutomaticManagedPagefile=False
wmic pagefileset where name="C:\\pagefile.sys" delete 2>nul
wmic pagefileset create name="C:\\pagefile.sys"
wmic pagefileset where name="C:\\pagefile.sys" set InitialSize=2048,MaximumSize=8192
echo.
echo === Hasil ===
wmic computersystem get AutomaticManagedPagefile
wmic pagefileset list brief
echo.
echo Perubahan berlaku penuh setelah restart.