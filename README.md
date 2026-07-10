[Unit]
Description=Force Plates Dashboard
After=network.target

[Service]
Type=oneshot
WorkingDirectory=/home/pi/ForcePlates
ExecStart=/home/pi/ForcePlates/start.sh
ExecStop=/home/pi/ForcePlates/start.sh --stop
RemainAfterExit=yes
TimeoutStartSec=60

[Install]
WantedBy=multi-user.target
