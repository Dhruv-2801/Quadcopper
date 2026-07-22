-- DE2_115_wrapper.vhd


library IEEE;
use IEEE.std_logic_1164.all;
use IEEE.numeric_std.all;

entity DE2_115_wrapper is
    port (
        CLOCK_50 : in  std_logic;
        KEY      : in  std_logic_vector(3 downto 0);
        SW       : in  std_logic_vector(17 downto 0);
        LEDR     : out std_logic_vector(17 downto 0);
        LEDG     : out std_logic_vector(8  downto 0);
        HEX0     : out std_logic_vector(6  downto 0);
        HEX1     : out std_logic_vector(6  downto 0);
        HEX2     : out std_logic_vector(6  downto 0);
        HEX3     : out std_logic_vector(6  downto 0);
        HEX4     : out std_logic_vector(6  downto 0);
        HEX5     : out std_logic_vector(6  downto 0);
        HEX6     : out std_logic_vector(6  downto 0);
        HEX7     : out std_logic_vector(6  downto 0)
    );
end entity DE2_115_wrapper;

architecture structural of DE2_115_wrapper is

    component wrapper is
        port (
            clk_clk                                   : in  std_logic;
            jtag_uart_0_avalon_jtag_slave_chipselect  : in  std_logic;
            jtag_uart_0_avalon_jtag_slave_address     : in  std_logic;
            jtag_uart_0_avalon_jtag_slave_read_n      : in  std_logic;
            jtag_uart_0_avalon_jtag_slave_readdata    : out std_logic_vector(31 downto 0);
            jtag_uart_0_avalon_jtag_slave_write_n     : in  std_logic;
            jtag_uart_0_avalon_jtag_slave_writedata   : in  std_logic_vector(31 downto 0);
            jtag_uart_0_avalon_jtag_slave_waitrequest : out std_logic;
            jtag_uart_0_clk_clk                       : in  std_logic;
            jtag_uart_0_irq_irq                       : out std_logic;
            jtag_uart_0_reset_reset_n                 : in  std_logic;
            reset_reset_n                              : in  std_logic
        );
    end component;

    component uart_loader is
        port (
            clk        : in  std_logic;
            rst        : in  std_logic;
            uart_byte  : in  std_logic_vector(7 downto 0);
            uart_valid : in  std_logic;
            mem_we     : out std_logic;
            mem_addr   : out std_logic_vector(31 downto 0);
            mem_data   : out std_logic_vector(31 downto 0);
            word_count : out std_logic_vector(9 downto 0);
            load_done  : out std_logic
        );
    end component;

    component RISCV_Processor is
        generic(N : integer := 32);
        port(iCLK      : in  std_logic;
             iRST      : in  std_logic;
             iInstLd   : in  std_logic;
             iInstAddr : in  std_logic_vector(N-1 downto 0);
             iInstExt  : in  std_logic_vector(N-1 downto 0);
             oALUOut   : out std_logic_vector(N-1 downto 0);
             oHalt     : out std_logic);
    end component;

    -- Single clock domain: everything below runs on CLOCK_50 directly.
    signal r_div       : unsigned(24 downto 0) := (others => '0');
    signal r_por_count : unsigned(3 downto 0) := (others => '0');
    signal s_por_done  : std_logic := '0';

    signal r_sw1_sync : std_logic_vector(1 downto 0) := (others => '0');
    signal r_sw2_sync : std_logic_vector(1 downto 0) := (others => '0');

    signal av_readdata    : std_logic_vector(31 downto 0);
    signal av_waitrequest : std_logic;
    signal av_read_n      : std_logic := '1';

    type rd_state_t is (RD_ISSUE, RD_WAIT);
    signal rd_state : rd_state_t := RD_ISSUE;

    signal s_uart_byte  : std_logic_vector(7 downto 0) := (others => '0');
    signal s_uart_valid : std_logic := '0';
    signal r_uart_activity : std_logic := '0';

    signal s_mem_we     : std_logic;
    signal s_mem_addr   : std_logic_vector(31 downto 0);
    signal s_mem_data   : std_logic_vector(31 downto 0);
    signal s_word_count : std_logic_vector(9 downto 0);
    signal s_load_done  : std_logic;
    signal s_loader_rst : std_logic;

    signal s_proc_rst : std_logic;
    signal s_ALUOut   : std_logic_vector(31 downto 0);
    signal s_Halt     : std_logic;
    signal r_captured : std_logic := '0';

begin

    process(CLOCK_50)
    begin
        if rising_edge(CLOCK_50) then
            r_div <= r_div + 1;
            if s_por_done = '0' then
                if r_por_count = "1111" then
                    s_por_done <= '1';
                else
                    r_por_count <= r_por_count + 1;
                end if;
            end if;
        end if;
    end process;

    process(CLOCK_50)
    begin
        if rising_edge(CLOCK_50) then
            r_sw1_sync <= r_sw1_sync(0) & SW(1);
            r_sw2_sync <= r_sw2_sync(0) & SW(2);
        end if;
    end process;

    U_UART : wrapper
        port map (
            clk_clk                                   => CLOCK_50,
            jtag_uart_0_clk_clk                       => CLOCK_50,
            jtag_uart_0_reset_reset_n                 => s_por_done,
            reset_reset_n                              => s_por_done,
            jtag_uart_0_avalon_jtag_slave_chipselect  => '1',
            jtag_uart_0_avalon_jtag_slave_address     => '0',
            jtag_uart_0_avalon_jtag_slave_read_n      => av_read_n,
            jtag_uart_0_avalon_jtag_slave_write_n     => '1',  -- never writing
            jtag_uart_0_avalon_jtag_slave_writedata   => (others => '0'),
            jtag_uart_0_avalon_jtag_slave_readdata    => av_readdata,
            jtag_uart_0_avalon_jtag_slave_waitrequest => av_waitrequest,
            jtag_uart_0_irq_irq                       => open
        );

    process(CLOCK_50)
    begin
        if rising_edge(CLOCK_50) then
            s_uart_valid <= '0';  -- default: single-cycle pulse

            if s_por_done = '0' then
                av_read_n <= '1';
                rd_state  <= RD_ISSUE;
            else
                case rd_state is
                    when RD_ISSUE =>
                        av_read_n <= '0';
                        rd_state  <= RD_WAIT;

                    when RD_WAIT =>
                        if av_waitrequest = '0' then
                            av_read_n <= '1';
                            if av_readdata(15) = '1' then  -- RVALID
                                s_uart_byte     <= av_readdata(7 downto 0);
                                s_uart_valid    <= '1';
                                r_uart_activity <= not r_uart_activity;
                            end if;
                            rd_state <= RD_ISSUE;
                        end if;
                end case;
            end if;
        end if;
    end process;

    U_LOADER : uart_loader
        port map (
            clk        => CLOCK_50,
            rst        => s_loader_rst,
            uart_byte  => s_uart_byte,
            uart_valid => s_uart_valid,
            mem_we     => s_mem_we,
            mem_addr   => s_mem_addr,
            mem_data   => s_mem_data,
            word_count => s_word_count,
            load_done  => s_load_done
        );

    s_loader_rst <= (not s_por_done) or r_sw2_sync(1);
    s_proc_rst   <= (not s_por_done) or (not s_load_done) or r_sw1_sync(1);

    U_PROC : RISCV_Processor
        generic map (N => 32)
        port map (
            iCLK      => CLOCK_50,
            iRST      => s_proc_rst,
            iInstLd   => s_mem_we,
            iInstAddr => s_mem_addr,
            iInstExt  => s_mem_data,
            oALUOut   => s_ALUOut,
            oHalt     => s_Halt
        );

    -- LEDG4 confirmation: r_captured latches once s_Halt fires (the
    -- program genuinely reached and retired the real WFI instruction --
    -- see RISCV_Processor.vhd's oHalt for how this is tracked correctly
    -- through every pipeline stage). SW(2) up (loader wipe) clears it so
    -- the next load re-arms.
    process(CLOCK_50)
    begin
        if rising_edge(CLOCK_50) then
            if s_loader_rst = '1' then
                r_captured <= '0';
            elsif s_Halt = '1' and r_captured = '0' then
                r_captured <= '1';
            end if;
        end if;
    end process;

    -- HEX left blank for now -- ALUOut display removed per request to
    -- keep the wrapper minimal. s_ALUOut is still wired up from
    -- RISCV_Processor if/when display logic gets added back.
    HEX0 <= (others => '1');
    HEX1 <= (others => '1');
    HEX2 <= (others => '1');
    HEX3 <= (others => '1');
    HEX4 <= (others => '1');
    HEX5 <= (others => '1');
    HEX6 <= (others => '1');
    HEX7 <= (others => '1');

    LEDR(9 downto 0)   <= s_word_count;
    LEDR(17 downto 10) <= (others => '0');

    LEDG(1)          <= s_por_done;
    LEDG(2)          <= r_div(23);
    LEDG(3)          <= s_load_done;
    LEDG(0)          <= r_uart_activity;
    LEDG(4)          <= r_captured;  -- sticky: program genuinely reached WFI and retired it
    LEDG(8 downto 5) <= (others => '0');

end architecture structural;
