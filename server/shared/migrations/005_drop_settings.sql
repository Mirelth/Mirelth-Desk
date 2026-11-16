-- settings 表自 001_init 建出后从未有任何读写（配置全走环境变量），移除以免误导。
DROP TABLE IF EXISTS settings;