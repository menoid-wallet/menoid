// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract TransferVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 206989942261695936024638633596286000992297386515353165070302588449103870868;
    uint256 constant deltax2 = 17910276786647147334633421295416430664193440570750331713366561237628169349817;
    uint256 constant deltay1 = 9619667141745434611773086656496550130951799284018694862016291822918265850435;
    uint256 constant deltay2 = 8948185479188479231771022259072395230472858105342660721755524194229372869279;

    
    uint256 constant IC0x = 12402872975597770514622611165574019188770079502551940249046971189941842341805;
    uint256 constant IC0y = 21431165659650738444742738753394829289215727836976047474917253100645007613158;
    
    uint256 constant IC1x = 16518635975877092135163024847315465623350496701423133703181344869191317563584;
    uint256 constant IC1y = 17761214241028476190502084767467457369075394677367339781016060459117531674117;
    
    uint256 constant IC2x = 677118160943044899503865476471783567340134242333849055063029293297696701586;
    uint256 constant IC2y = 18289177532758185365189542802159484158382876091635812052868002614315414730111;
    
    uint256 constant IC3x = 12573122276528738518863822853895164749267012007059402169559134475521575024179;
    uint256 constant IC3y = 1000807773114093988761438558047919666988093962034002327009132834576506686479;
    
    uint256 constant IC4x = 19903501993748136736951234354570718484827367758251934353391501709516574896055;
    uint256 constant IC4y = 89492360307135838395772186016097384569363624772849675497458582314224438874;
    
    uint256 constant IC5x = 10649183424348016129384721524527356666179047322556466565289950259886467211949;
    uint256 constant IC5y = 15535383099837705376384168333328066164280077306167912055372845969326211355449;
    
    uint256 constant IC6x = 17508030543063078302402881898132424303198667726255527863380330363046213074418;
    uint256 constant IC6y = 1799527869533177912683197364281804153630463020568975445062171561855944114236;
    
    uint256 constant IC7x = 17913612113061514669345601568042204392588449806576645387041194988785023912515;
    uint256 constant IC7y = 15766986784486816380310042653300118806033645914184615268130728553869152891519;
    
    uint256 constant IC8x = 9141492015405830002197510638578669819739319233041367825509122104048167529473;
    uint256 constant IC8y = 12992257246411341140313282245459365732993859183419840779389102650131852600182;
    
    uint256 constant IC9x = 11782449605679585727814027780473817844489317737684894338026446939915555488286;
    uint256 constant IC9y = 6717804259160439504892811669657147080295520075042635449001940440454914482345;
    
    uint256 constant IC10x = 19560637487170443035542617951730399159125370456405523094747516277293686499019;
    uint256 constant IC10y = 11762418046714284427640117053327045862896037784082749764207635735878076612236;
    
    uint256 constant IC11x = 18206433154466162283622355717719914593592619233683496990936118210190065974719;
    uint256 constant IC11y = 6675813701223498248623335127471136846732001047672191706692329993860316225510;
    
    uint256 constant IC12x = 17735159316681718315116096215328768681315789841190780803366979302152881242842;
    uint256 constant IC12y = 17274856783138427623822389265978692157025637022807830458392407154420533818658;
    
    uint256 constant IC13x = 3190280282864359561811267037752398601176663910140529129550374639097000111315;
    uint256 constant IC13y = 18166941458829518781456207861441100265116279495618578484171569765299264711691;
    
    uint256 constant IC14x = 10113983776735378363126447756145045610082702807577291734177554272780966161279;
    uint256 constant IC14y = 12530401198935110376500939404471319818532568503724302230143108866173291635752;
    
    uint256 constant IC15x = 2490070187471140588306549133599984083010944890978147010100844061536773182289;
    uint256 constant IC15y = 8460327431858589469090892752593023164198148442501561040790749909901577260430;
    
    uint256 constant IC16x = 6696135673211513964453802962227954545853828623780019577293203664140069284244;
    uint256 constant IC16y = 16633223660974480225216458982788475659817206239256199614836751458904430141156;
    
    uint256 constant IC17x = 2186866777762953540294204801620987385534617345404044818842445122110955722030;
    uint256 constant IC17y = 2527749018316631455184694770046057297546587248625454450460197695385057716199;
    
    uint256 constant IC18x = 8272142454403101589195014730026431771454827274202902243365997946469281047864;
    uint256 constant IC18y = 12392863345220396765547485192553939951582089607076555746295086280313832648730;
    
    uint256 constant IC19x = 15114045133443925360531408986040301476611128977058258819316087960494912708532;
    uint256 constant IC19y = 1451762447414822505517657705772569210504431982827351958980888236740484105671;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[19] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
