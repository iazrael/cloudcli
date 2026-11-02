@echo off
REM cloudcli 开机自启：恢复 pm2 托管的服务
cd /d "E:\Projects\cloudcli"
call pm2 resurrect
exit
